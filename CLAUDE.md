# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
# Build the application (regenerates proto files first)
make build

# Regenerate gRPC stubs from proto files
make proto

# Run locally with Docker
docker compose up --build

# Run tests (standard Go testing)
go test ./...
```

## Environment Setup

Copy `.env.template` to `.env` and configure:
- `AB_BASE_URL` - AccelByte Gaming Services base URL
- `AB_CLIENT_ID` / `AB_CLIENT_SECRET` - OAuth client credentials
- `AB_NAMESPACE` - Your AGS namespace
- `PLUGIN_GRPC_SERVER_AUTH_ENABLED` - Enable/disable auth validation (default: true)
- `BASE_PATH` - REST API base path (e.g., `/pong`)

## Architecture

This is an AGS (AccelByte Gaming Services) Extend Service Extension - a gRPC server with REST gateway for extending AGS capabilities.

### Request Flow
```
Client → gRPC Gateway (:8000) → gRPC Server (:6565) → Service Implementation
```

### Key Files to Modify

1. **`pkg/proto/service.proto`** - Define gRPC service methods and REST mappings
   - Uses `google.api.http` annotations for REST endpoints
   - Uses `permission.action` and `permission.resource` for AGS authorization
   - OpenAPI annotations generate Swagger docs

2. **`pkg/service/pongService.go`** - Implement gRPC method handlers
   - Access AGS SDK through injected repositories (tokenRepo, configRepo)

3. **`pkg/common/authServerInterceptor.go`** - Auth logic (modify if needed)
   - Extracts auth requirements from proto annotations
   - Validates tokens and permissions via AGS IAM

### Generated Files (do not edit)
- `pkg/pb/*.go` - Generated from proto files via `make proto`
- `gateway/apidocs/*.swagger.json` - Generated OpenAPI spec

### Ports
- `:6565` - gRPC server
- `:8000` - gRPC-Gateway (REST API + Swagger UI at `{BASE_PATH}/apidocs/`)
- `:8080` - Prometheus metrics at `/metrics`

## Proto Workflow

When modifying `service.proto`:
1. Define your RPC methods with HTTP annotations
2. Add permission annotations for AGS authorization
3. Run `make proto` to regenerate stubs
4. Implement handlers in `pkg/service/`

## Testing

- Target **80%+ code coverage** for all new code
- Unit tests act as integration tests with mocks for external AGS services
- Mock AGS SDK calls (Statistics, Leaderboard, IAM) rather than making real API calls
- Run tests: `go test ./... -cover`

## Code Style

- Use early return pattern instead of nested conditionals
- Ask before performing destructive operations (e.g., DB deletes)

## Project Documentation

- **`docs/pong-game-tech-spec.md`** - Technical specification for the Pong game implementation, including AGS integration details, API contracts, and frontend architecture
