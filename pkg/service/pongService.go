// Copyright (c) 2023-2025 AccelByte Inc. All Rights Reserved.
// This is licensed software from AccelByte Inc, for limitations
// and restrictions contact your company contract manager.

package service

import (
	"context"

	pb "extend-pong/pkg/pb"
	"extend-pong/pkg/service/ags"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	// PongHighScoreStatCode is the stat code for tracking pong high scores
	PongHighScoreStatCode = "pong-high-score"
	// PongLeaderboardCode is the leaderboard code for pong rankings
	PongLeaderboardCode = "pong-leaderboard"

	// Multiplayer stat codes
	PongMPWinsStatCode    = "pong-mp-wins"
	PongMPLossesStatCode  = "pong-mp-losses"
	PongMPMatchesStatCode = "pong-mp-matches"

	// PongMPWinsLeaderboardCode is the leaderboard code for multiplayer wins
	PongMPWinsLeaderboardCode = "pong-mp-wins-leaderboard"
)

type PongServiceServerImpl struct {
	pb.UnimplementedPongServiceServer
	namespace          string
	statisticsService  ags.StatisticsService
	leaderboardService ags.LeaderboardService
}

func NewPongServiceServer(
	namespace string,
	statisticsService ags.StatisticsService,
	leaderboardService ags.LeaderboardService,
) *PongServiceServerImpl {
	return &PongServiceServerImpl{
		namespace:          namespace,
		statisticsService:  statisticsService,
		leaderboardService: leaderboardService,
	}
}

func (s *PongServiceServerImpl) SubmitScore(
	ctx context.Context, req *pb.SubmitScoreRequest,
) (*pb.SubmitScoreResponse, error) {
	if req.Score < 0 {
		return nil, status.Errorf(codes.InvalidArgument, "score must be non-negative")
	}

	if req.UserId == "" {
		return nil, status.Errorf(codes.InvalidArgument, "user_id is required")
	}

	err := s.statisticsService.UpdateUserStatItem(
		ctx,
		s.namespace,
		req.UserId,
		PongHighScoreStatCode,
		float64(req.Score),
	)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to submit score: %v", err)
	}

	return &pb.SubmitScoreResponse{
		Success: true,
		Message: "Score submitted successfully",
	}, nil
}

func (s *PongServiceServerImpl) GetLeaderboard(
	ctx context.Context, req *pb.GetLeaderboardRequest,
) (*pb.GetLeaderboardResponse, error) {
	limit := req.Limit
	if limit <= 0 {
		limit = 10
	}
	if limit > 100 {
		limit = 100
	}

	offset := req.Offset
	if offset < 0 {
		offset = 0
	}

	// Use requested leaderboard code or default to single-player leaderboard
	leaderboardCode := req.LeaderboardCode
	if leaderboardCode == "" {
		leaderboardCode = PongLeaderboardCode
	}

	result, err := s.leaderboardService.GetAllTimeLeaderboard(
		ctx,
		s.namespace,
		leaderboardCode,
		int64(limit),
		int64(offset),
	)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get leaderboard: %v", err)
	}

	entries := make([]*pb.LeaderboardEntry, 0, len(result.Entries))
	for _, entry := range result.Entries {
		entries = append(entries, &pb.LeaderboardEntry{
			Rank:      entry.Rank,
			UserId:    entry.UserID,
			Score:     int32(entry.Score),
			Timestamp: ags.GetTimestamp(),
		})
	}

	return &pb.GetLeaderboardResponse{
		Entries:    entries,
		TotalCount: result.TotalCount,
	}, nil
}

func (s *PongServiceServerImpl) SubmitMultiplayerResult(
	ctx context.Context, req *pb.SubmitMultiplayerResultRequest,
) (*pb.SubmitMultiplayerResultResponse, error) {
	if req.UserId == "" {
		return nil, status.Errorf(codes.InvalidArgument, "user_id is required")
	}

	// Build stat updates based on match result
	updates := []ags.StatUpdate{
		{StatCode: PongMPMatchesStatCode, Value: 1},
	}

	if req.Won {
		updates = append(updates, ags.StatUpdate{StatCode: PongMPWinsStatCode, Value: 1})
	} else {
		updates = append(updates, ags.StatUpdate{StatCode: PongMPLossesStatCode, Value: 1})
	}

	err := s.statisticsService.BulkUpdateUserStats(ctx, s.namespace, req.UserId, updates)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to submit multiplayer result: %v", err)
	}

	return &pb.SubmitMultiplayerResultResponse{
		Success: true,
		Message: "Multiplayer result submitted successfully",
	}, nil
}
