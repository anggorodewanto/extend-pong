// Copyright (c) 2023-2025 AccelByte Inc. All Rights Reserved.
// This is licensed software from AccelByte Inc, for limitations
// and restrictions contact your company contract manager.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"extend-custom-guild-service/pkg/service"
	"extend-custom-guild-service/pkg/service/ags"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/go-openapi/loads"

	"extend-custom-guild-service/pkg/common"

	"github.com/AccelByte/accelbyte-go-sdk/services-api/pkg/repository"

	"github.com/AccelByte/accelbyte-go-sdk/services-api/pkg/factory"
	"github.com/AccelByte/accelbyte-go-sdk/services-api/pkg/service/iam"
	"github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/logging"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/sirupsen/logrus"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"go.opentelemetry.io/contrib/propagators/b3"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"

	pb "extend-custom-guild-service/pkg/pb"

	sdkAuth "github.com/AccelByte/accelbyte-go-sdk/services-api/pkg/utils/auth"
	prometheusGrpc "github.com/grpc-ecosystem/go-grpc-prometheus"
	prometheusCollectors "github.com/prometheus/client_golang/prometheus/collectors"
)

const (
	metricsEndpoint     = "/metrics"
	metricsPort         = 8080
	grpcServerPort      = 6565
	grpcGatewayHTTPPort = 8000
)

var (
	serviceName = common.GetEnv("OTEL_SERVICE_NAME", "ExtendCustomServiceGo")
	logLevelStr = common.GetEnv("LOG_LEVEL", logrus.InfoLevel.String())
	basePath	= common.GetBasePath()
)

func main() {
	logrus.Infof("Starting %s...", serviceName)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	logrusLevel, err := logrus.ParseLevel(logLevelStr)
	if err != nil {
		logrusLevel = logrus.InfoLevel
	}
	logrusLogger := logrus.New()
	logrusLogger.SetLevel(logrusLevel)

	loggingOptions := []logging.Option{
		logging.WithLogOnEvents(logging.StartCall, logging.FinishCall, logging.PayloadReceived, logging.PayloadSent),
		logging.WithFieldsFromContext(func(ctx context.Context) logging.Fields {
			if span := trace.SpanContextFromContext(ctx); span.IsSampled() {
				return logging.Fields{"traceID", span.TraceID().String()}
			}

			return nil
		}),
		logging.WithLevels(logging.DefaultClientCodeToLevel),
		logging.WithDurationField(logging.DurationToDurationField),
	}

	unaryServerInterceptors := []grpc.UnaryServerInterceptor{
		prometheusGrpc.UnaryServerInterceptor,
		logging.UnaryServerInterceptor(common.InterceptorLogger(logrusLogger), loggingOptions...),
	}
	streamServerInterceptors := []grpc.StreamServerInterceptor{
		prometheusGrpc.StreamServerInterceptor,
		logging.StreamServerInterceptor(common.InterceptorLogger(logrusLogger), loggingOptions...),
	}

	// Preparing the IAM authorization
	var tokenRepo repository.TokenRepository = sdkAuth.DefaultTokenRepositoryImpl()
	var configRepo repository.ConfigRepository = sdkAuth.DefaultConfigRepositoryImpl()
	var refreshRepo repository.RefreshTokenRepository = &sdkAuth.RefreshTokenImpl{RefreshRate: 0.8, AutoRefresh: true}

	oauthService := iam.OAuth20Service{
		Client:                 factory.NewIamClient(configRepo),
		TokenRepository:        tokenRepo,
		RefreshTokenRepository: refreshRepo,
		ConfigRepository:       configRepo,
	}

	if strings.ToLower(common.GetEnv("PLUGIN_GRPC_SERVER_AUTH_ENABLED", "true")) == "true" {
		refreshInterval := common.GetEnvInt("REFRESH_INTERVAL", 600)
		common.Validator = common.NewTokenValidator(oauthService, time.Duration(refreshInterval)*time.Second, true)
		err := common.Validator.Initialize(ctx)
		if err != nil {
			logrus.Infof("validator initialization error: %v", err)
		}

		unaryServerInterceptor := common.NewUnaryAuthServerIntercept()
		serverServerInterceptor := common.NewStreamAuthServerIntercept()

		unaryServerInterceptors = append(unaryServerInterceptors, unaryServerInterceptor)
		streamServerInterceptors = append(streamServerInterceptors, serverServerInterceptor)
		logrus.Infof("added auth interceptors")
	}

	// Create gRPC Server
	s := grpc.NewServer(
		grpc.StatsHandler(otelgrpc.NewServerHandler()),
		grpc.ChainUnaryInterceptor(unaryServerInterceptors...),
		grpc.ChainStreamInterceptor(streamServerInterceptors...),
	)

	// Configure IAM authorization
	clientId := configRepo.GetClientId()
	clientSecret := configRepo.GetClientSecret()
	err = oauthService.LoginClient(&clientId, &clientSecret)
	if err != nil {
		logrus.Fatalf("Error unable to login using clientId and clientSecret: %v", err)
	}

	// Initialize AGS services (real or mock based on env var)
	var statisticsService ags.StatisticsService
	var leaderboardService ags.LeaderboardService

	namespace := common.GetEnv("AB_NAMESPACE", "accelbyte")

	if strings.ToLower(common.GetEnv("AGS_MOCK_ENABLED", "false")) == "true" {
		logrus.Info("Using MOCK AGS services")
		linkedMocks := ags.NewLinkedMockServices(namespace, service.PongHighScoreStatCode, service.PongLeaderboardCode)
		linkedMocks.SeedSampleData()
		statisticsService = linkedMocks
		leaderboardService = linkedMocks.Leaderboard
	} else {
		logrus.Info("Using REAL AGS services")
		statisticsService = ags.NewAGSStatisticsService(configRepo, tokenRepo, logrusLogger)
		leaderboardService = ags.NewAGSLeaderboardService(configRepo, tokenRepo, logrusLogger)
	}

	// Register Pong Service
	pongServiceServer := service.NewPongServiceServer(namespace, statisticsService, leaderboardService)
	pb.RegisterPongServiceServer(s, pongServiceServer)

	// Enable gRPC Reflection
	reflection.Register(s)

	// Enable gRPC Health Check
	grpc_health_v1.RegisterHealthServer(s, health.NewServer())

	// Create a new HTTP server for the gRPC-Gateway
	grpcGateway, err := common.NewGateway(ctx, fmt.Sprintf("localhost:%d", grpcServerPort), basePath)
	if err != nil {
		logrus.Fatalf("Failed to create gRPC-Gateway: %v", err)
	}

	// Start the gRPC-Gateway HTTP server
	go func() {
		swaggerDir := "gateway/apidocs" // Path to swagger directory
		grpcGatewayHTTPServer := newGRPCGatewayHTTPServer(fmt.Sprintf(":%d", grpcGatewayHTTPPort), grpcGateway, logrus.New(), swaggerDir)
		logrus.Infof("Starting gRPC-Gateway HTTP server on port %d", grpcGatewayHTTPPort)
		if err := grpcGatewayHTTPServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logrus.Fatalf("Failed to run gRPC-Gateway HTTP server: %v", err)
		}
	}()

	prometheusGrpc.Register(s)

	// Register Prometheus Metrics
	prometheusRegistry := prometheus.NewRegistry()
	prometheusRegistry.MustRegister(
		prometheusCollectors.NewGoCollector(),
		prometheusCollectors.NewProcessCollector(prometheusCollectors.ProcessCollectorOpts{}),
		prometheusGrpc.DefaultServerMetrics,
	)

	go func() {
		http.Handle(metricsEndpoint, promhttp.HandlerFor(prometheusRegistry, promhttp.HandlerOpts{}))
		logrus.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", metricsPort), nil))
	}()
	logrus.Infof("Metrics endpoint: (:%d%s)", metricsPort, metricsEndpoint)

	// Set Tracer Provider
	tracerProvider, err := common.NewTracerProvider(serviceName)
	if err != nil {
		logrus.Fatalf("Failed to create tracer provider: %v", err)

		return
	}
	otel.SetTracerProvider(tracerProvider)
	defer func(ctx context.Context) {
		if err := tracerProvider.Shutdown(ctx); err != nil {
			logrus.Fatal(err)
		}
	}(ctx)

	// Set Text Map Propagator
	otel.SetTextMapPropagator(
		propagation.NewCompositeTextMapPropagator(
			b3.New(),
			propagation.TraceContext{},
			propagation.Baggage{},
		),
	)

	// Start gRPC Server	
	lis, err := net.Listen("tcp", fmt.Sprintf(":%d", grpcServerPort))
	if err != nil {
		logrus.Fatalf("Failed to listen to tcp:%d: %v", grpcServerPort, err)

		return
	}
	go func() {
		if err = s.Serve(lis); err != nil {
			logrus.Fatalf("Failed to run gRPC server: %v", err)

			return
		}
	}()

	logrus.Infof("%s started", serviceName)

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	logrus.Infof("SIGTERM received")
}

func newGRPCGatewayHTTPServer(
	addr string, grpcGateway http.Handler, logger *logrus.Logger, swaggerDir string,
) *http.Server {
	// Create a new ServeMux
	mux := http.NewServeMux()

	// Serve Swagger UI and JSON
	serveSwaggerUI(mux)
	serveSwaggerJSON(mux, swaggerDir)

	// Create combined handler for API and static files
	staticHandler := createStaticHandler()
	combinedHandler := createCombinedHandler(grpcGateway, staticHandler)
	mux.Handle("/", combinedHandler)

	// Add logging middleware
	loggedMux := loggingMiddleware(logger, mux)

	return &http.Server{
		Addr:     addr,
		Handler:  loggedMux,
		ErrorLog: log.New(os.Stderr, "httpSrv: ", log.LstdFlags), // Configure the logger for the HTTP server
	}
}

// responseWriter wraps http.ResponseWriter to capture the status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// loggingMiddleware is a middleware that logs HTTP requests
func loggingMiddleware(logger *logrus.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		wrapped := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(wrapped, r)
		duration := time.Since(start)
		logger.WithFields(logrus.Fields{
			"method":   r.Method,
			"path":     r.URL.Path,
			"status":   wrapped.statusCode,
			"duration": duration,
		}).Info("HTTP request")
	})
}

func serveSwaggerUI(mux *http.ServeMux) {
	swaggerUIDir := "third_party/swagger-ui"
	fileServer := http.FileServer(http.Dir(swaggerUIDir))
	swaggerUiPath := fmt.Sprintf("%s/apidocs/", basePath)
	mux.Handle(swaggerUiPath, http.StripPrefix(swaggerUiPath, fileServer))
}

func serveSwaggerJSON(mux *http.ServeMux, swaggerDir string) {
	fileHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		matchingFiles, err := filepath.Glob(filepath.Join(swaggerDir, "*.swagger.json"))
		if err != nil || len(matchingFiles) == 0 {
			http.Error(w, "Error finding Swagger JSON file", http.StatusInternalServerError)

			return
		}

		firstMatchingFile := matchingFiles[0]
		swagger, err := loads.Spec(firstMatchingFile)
		if err != nil {
			http.Error(w, "Error parsing Swagger JSON file", http.StatusInternalServerError)

			return
		}

		// Update the base path
		swagger.Spec().BasePath = basePath

		updatedSwagger, err := swagger.Spec().MarshalJSON()
		if err != nil {
			http.Error(w, "Error serializing updated Swagger JSON", http.StatusInternalServerError)

			return
		}
		var prettySwagger bytes.Buffer
		err = json.Indent(&prettySwagger, updatedSwagger, "", "  ")
		if err != nil {
			http.Error(w, "Error formatting updated Swagger JSON", http.StatusInternalServerError)

			return
		}

		_, err = w.Write(prettySwagger.Bytes())
		if err != nil {
			http.Error(w, "Error writing Swagger JSON response", http.StatusInternalServerError)

			return
		}
	})
	apidocsPath := fmt.Sprintf("%s/apidocs/api.json", basePath)
	mux.Handle(apidocsPath, fileHandler)
}

func createStaticHandler() http.Handler {
	staticDir := common.GetEnv("STATIC_FILES_PATH", "./static")

	// Check if static directory exists
	if _, err := os.Stat(staticDir); os.IsNotExist(err) {
		logrus.Warnf("Static files directory '%s' does not exist", staticDir)

		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		})
	}

	logrus.Infof("Static files will be served from '%s' at path '%s/'", staticDir, basePath)

	return http.StripPrefix(basePath, http.FileServer(http.Dir(staticDir)))
}

func createCombinedHandler(grpcGateway http.Handler, staticHandler http.Handler) http.Handler {
	apiPrefix := basePath + "/v1/"

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Route API requests to gRPC gateway
		if strings.HasPrefix(r.URL.Path, apiPrefix) {
			grpcGateway.ServeHTTP(w, r)

			return
		}

		// Route requests under basePath to static files
		if strings.HasPrefix(r.URL.Path, basePath+"/") || r.URL.Path == basePath {
			staticHandler.ServeHTTP(w, r)

			return
		}

		// Everything else goes to gRPC gateway (for potential other routes)
		grpcGateway.ServeHTTP(w, r)
	})
}
