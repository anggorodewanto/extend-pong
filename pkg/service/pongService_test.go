// Copyright (c) 2023-2025 AccelByte Inc. All Rights Reserved.
// This is licensed software from AccelByte Inc, for limitations
// and restrictions contact your company contract manager.

package service

import (
	"context"
	"errors"
	"testing"

	pb "extend-custom-guild-service/pkg/pb"
	"extend-custom-guild-service/pkg/service/ags"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// mockStatisticsService is a configurable mock for testing
type mockStatisticsService struct {
	updateErr error
	called    bool
	lastCall  struct {
		namespace string
		userID    string
		statCode  string
		value     float64
	}
}

func (m *mockStatisticsService) UpdateUserStatItem(
	ctx context.Context,
	namespace, userID, statCode string,
	value float64,
) error {
	m.called = true
	m.lastCall.namespace = namespace
	m.lastCall.userID = userID
	m.lastCall.statCode = statCode
	m.lastCall.value = value
	return m.updateErr
}

// mockLeaderboardService is a configurable mock for testing
type mockLeaderboardService struct {
	result   *ags.LeaderboardResult
	err      error
	called   bool
	lastCall struct {
		namespace       string
		leaderboardCode string
		limit           int64
		offset          int64
	}
}

func (m *mockLeaderboardService) GetAllTimeLeaderboard(
	ctx context.Context,
	namespace, leaderboardCode string,
	limit, offset int64,
) (*ags.LeaderboardResult, error) {
	m.called = true
	m.lastCall.namespace = namespace
	m.lastCall.leaderboardCode = leaderboardCode
	m.lastCall.limit = limit
	m.lastCall.offset = offset
	return m.result, m.err
}

func TestNewPongServiceServer(t *testing.T) {
	statsService := &mockStatisticsService{}
	lbService := &mockLeaderboardService{}

	server := NewPongServiceServer("test-namespace", statsService, lbService)

	assert.NotNil(t, server)
	assert.Equal(t, "test-namespace", server.namespace)
	assert.Equal(t, statsService, server.statisticsService)
	assert.Equal(t, lbService, server.leaderboardService)
}

func TestSubmitScore_Success(t *testing.T) {
	statsService := &mockStatisticsService{}
	lbService := &mockLeaderboardService{}
	server := NewPongServiceServer("test-namespace", statsService, lbService)

	req := &pb.SubmitScoreRequest{
		UserId: "user-123",
		Score:  100,
	}

	resp, err := server.SubmitScore(context.Background(), req)

	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, "Score submitted successfully", resp.Message)

	// Verify statistics service was called correctly
	assert.True(t, statsService.called)
	assert.Equal(t, "test-namespace", statsService.lastCall.namespace)
	assert.Equal(t, "user-123", statsService.lastCall.userID)
	assert.Equal(t, PongHighScoreStatCode, statsService.lastCall.statCode)
	assert.Equal(t, float64(100), statsService.lastCall.value)
}

func TestSubmitScore_ZeroScore(t *testing.T) {
	statsService := &mockStatisticsService{}
	lbService := &mockLeaderboardService{}
	server := NewPongServiceServer("test-namespace", statsService, lbService)

	req := &pb.SubmitScoreRequest{
		UserId: "user-123",
		Score:  0,
	}

	resp, err := server.SubmitScore(context.Background(), req)

	require.NoError(t, err)
	assert.True(t, resp.Success)
}

func TestSubmitScore_NegativeScore(t *testing.T) {
	statsService := &mockStatisticsService{}
	lbService := &mockLeaderboardService{}
	server := NewPongServiceServer("test-namespace", statsService, lbService)

	req := &pb.SubmitScoreRequest{
		UserId: "user-123",
		Score:  -1,
	}

	resp, err := server.SubmitScore(context.Background(), req)

	assert.Nil(t, resp)
	require.Error(t, err)

	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.InvalidArgument, st.Code())
	assert.Contains(t, st.Message(), "score must be non-negative")
}

func TestSubmitScore_EmptyUserId(t *testing.T) {
	statsService := &mockStatisticsService{}
	lbService := &mockLeaderboardService{}
	server := NewPongServiceServer("test-namespace", statsService, lbService)

	req := &pb.SubmitScoreRequest{
		UserId: "",
		Score:  100,
	}

	resp, err := server.SubmitScore(context.Background(), req)

	assert.Nil(t, resp)
	require.Error(t, err)

	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.InvalidArgument, st.Code())
	assert.Contains(t, st.Message(), "user_id is required")
}

func TestSubmitScore_StatisticsServiceError(t *testing.T) {
	statsService := &mockStatisticsService{
		updateErr: errors.New("service unavailable"),
	}
	lbService := &mockLeaderboardService{}
	server := NewPongServiceServer("test-namespace", statsService, lbService)

	req := &pb.SubmitScoreRequest{
		UserId: "user-123",
		Score:  100,
	}

	resp, err := server.SubmitScore(context.Background(), req)

	assert.Nil(t, resp)
	require.Error(t, err)

	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.Internal, st.Code())
	assert.Contains(t, st.Message(), "failed to submit score")
}

func TestGetLeaderboard_Success(t *testing.T) {
	statsService := &mockStatisticsService{}
	lbService := &mockLeaderboardService{
		result: &ags.LeaderboardResult{
			Entries: []ags.LeaderboardEntry{
				{Rank: 1, UserID: "user-1", Score: 100},
				{Rank: 2, UserID: "user-2", Score: 90},
				{Rank: 3, UserID: "user-3", Score: 80},
			},
			TotalCount: 3,
		},
	}
	server := NewPongServiceServer("test-namespace", statsService, lbService)

	req := &pb.GetLeaderboardRequest{
		Limit:  10,
		Offset: 0,
	}

	resp, err := server.GetLeaderboard(context.Background(), req)

	require.NoError(t, err)
	assert.Len(t, resp.Entries, 3)
	assert.Equal(t, int32(3), resp.TotalCount)

	// Verify first entry
	assert.Equal(t, int32(1), resp.Entries[0].Rank)
	assert.Equal(t, "user-1", resp.Entries[0].UserId)
	assert.Equal(t, int32(100), resp.Entries[0].Score)

	// Verify leaderboard service was called correctly
	assert.True(t, lbService.called)
	assert.Equal(t, "test-namespace", lbService.lastCall.namespace)
	assert.Equal(t, PongLeaderboardCode, lbService.lastCall.leaderboardCode)
	assert.Equal(t, int64(10), lbService.lastCall.limit)
	assert.Equal(t, int64(0), lbService.lastCall.offset)
}

func TestGetLeaderboard_DefaultLimit(t *testing.T) {
	statsService := &mockStatisticsService{}
	lbService := &mockLeaderboardService{
		result: &ags.LeaderboardResult{
			Entries:    []ags.LeaderboardEntry{},
			TotalCount: 0,
		},
	}
	server := NewPongServiceServer("test-namespace", statsService, lbService)

	req := &pb.GetLeaderboardRequest{
		Limit:  0, // Should default to 10
		Offset: 0,
	}

	_, err := server.GetLeaderboard(context.Background(), req)

	require.NoError(t, err)
	assert.Equal(t, int64(10), lbService.lastCall.limit)
}

func TestGetLeaderboard_NegativeLimit(t *testing.T) {
	statsService := &mockStatisticsService{}
	lbService := &mockLeaderboardService{
		result: &ags.LeaderboardResult{
			Entries:    []ags.LeaderboardEntry{},
			TotalCount: 0,
		},
	}
	server := NewPongServiceServer("test-namespace", statsService, lbService)

	req := &pb.GetLeaderboardRequest{
		Limit:  -5, // Should default to 10
		Offset: 0,
	}

	_, err := server.GetLeaderboard(context.Background(), req)

	require.NoError(t, err)
	assert.Equal(t, int64(10), lbService.lastCall.limit)
}

func TestGetLeaderboard_MaxLimit(t *testing.T) {
	statsService := &mockStatisticsService{}
	lbService := &mockLeaderboardService{
		result: &ags.LeaderboardResult{
			Entries:    []ags.LeaderboardEntry{},
			TotalCount: 0,
		},
	}
	server := NewPongServiceServer("test-namespace", statsService, lbService)

	req := &pb.GetLeaderboardRequest{
		Limit:  200, // Should be capped to 100
		Offset: 0,
	}

	_, err := server.GetLeaderboard(context.Background(), req)

	require.NoError(t, err)
	assert.Equal(t, int64(100), lbService.lastCall.limit)
}

func TestGetLeaderboard_NegativeOffset(t *testing.T) {
	statsService := &mockStatisticsService{}
	lbService := &mockLeaderboardService{
		result: &ags.LeaderboardResult{
			Entries:    []ags.LeaderboardEntry{},
			TotalCount: 0,
		},
	}
	server := NewPongServiceServer("test-namespace", statsService, lbService)

	req := &pb.GetLeaderboardRequest{
		Limit:  10,
		Offset: -5, // Should default to 0
	}

	_, err := server.GetLeaderboard(context.Background(), req)

	require.NoError(t, err)
	assert.Equal(t, int64(0), lbService.lastCall.offset)
}

func TestGetLeaderboard_ServiceError(t *testing.T) {
	statsService := &mockStatisticsService{}
	lbService := &mockLeaderboardService{
		err: errors.New("database error"),
	}
	server := NewPongServiceServer("test-namespace", statsService, lbService)

	req := &pb.GetLeaderboardRequest{
		Limit:  10,
		Offset: 0,
	}

	resp, err := server.GetLeaderboard(context.Background(), req)

	assert.Nil(t, resp)
	require.Error(t, err)

	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.Internal, st.Code())
	assert.Contains(t, st.Message(), "failed to get leaderboard")
}

func TestGetLeaderboard_EmptyResult(t *testing.T) {
	statsService := &mockStatisticsService{}
	lbService := &mockLeaderboardService{
		result: &ags.LeaderboardResult{
			Entries:    []ags.LeaderboardEntry{},
			TotalCount: 0,
		},
	}
	server := NewPongServiceServer("test-namespace", statsService, lbService)

	req := &pb.GetLeaderboardRequest{
		Limit:  10,
		Offset: 0,
	}

	resp, err := server.GetLeaderboard(context.Background(), req)

	require.NoError(t, err)
	assert.Len(t, resp.Entries, 0)
	assert.Equal(t, int32(0), resp.TotalCount)
}

func TestGetLeaderboard_WithPagination(t *testing.T) {
	statsService := &mockStatisticsService{}
	lbService := &mockLeaderboardService{
		result: &ags.LeaderboardResult{
			Entries: []ags.LeaderboardEntry{
				{Rank: 11, UserID: "user-11", Score: 50},
				{Rank: 12, UserID: "user-12", Score: 45},
			},
			TotalCount: 20,
		},
	}
	server := NewPongServiceServer("test-namespace", statsService, lbService)

	req := &pb.GetLeaderboardRequest{
		Limit:  10,
		Offset: 10,
	}

	resp, err := server.GetLeaderboard(context.Background(), req)

	require.NoError(t, err)
	assert.Len(t, resp.Entries, 2)
	assert.Equal(t, int32(20), resp.TotalCount)
	assert.Equal(t, int64(10), lbService.lastCall.offset)
}

func TestConstants(t *testing.T) {
	// Verify constants are defined correctly
	assert.Equal(t, "pong_high_score", PongHighScoreStatCode)
	assert.Equal(t, "pong_leaderboard", PongLeaderboardCode)
}
