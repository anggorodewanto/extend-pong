// Copyright (c) 2023-2025 AccelByte Inc. All Rights Reserved.
// This is licensed software from AccelByte Inc, for limitations
// and restrictions contact your company contract manager.

package ags

import (
	"context"
	"fmt"

	"github.com/AccelByte/accelbyte-go-sdk/leaderboard-sdk/pkg/leaderboardclient/leaderboard_data_v3"
	"github.com/AccelByte/accelbyte-go-sdk/services-api/pkg/factory"
	"github.com/AccelByte/accelbyte-go-sdk/services-api/pkg/repository"
	"github.com/AccelByte/accelbyte-go-sdk/services-api/pkg/service/leaderboard"
	"github.com/sirupsen/logrus"
)

// AGSLeaderboardService implements LeaderboardService using the AccelByte SDK
type AGSLeaderboardService struct {
	leaderboardDataV3Service *leaderboard.LeaderboardDataV3Service
	logger                   *logrus.Logger
}

// NewAGSLeaderboardService creates a new AGS Leaderboard service
func NewAGSLeaderboardService(
	configRepo repository.ConfigRepository,
	tokenRepo repository.TokenRepository,
	logger *logrus.Logger,
) *AGSLeaderboardService {
	leaderboardClient := factory.NewLeaderboardClient(configRepo)
	return &AGSLeaderboardService{
		leaderboardDataV3Service: &leaderboard.LeaderboardDataV3Service{
			Client:           leaderboardClient,
			ConfigRepository: configRepo,
			TokenRepository:  tokenRepo,
		},
		logger: logger,
	}
}

// GetAllTimeLeaderboard retrieves the all-time leaderboard rankings
func (s *AGSLeaderboardService) GetAllTimeLeaderboard(
	ctx context.Context,
	namespace, leaderboardCode string,
	limit, offset int64,
) (*LeaderboardResult, error) {
	params := leaderboard_data_v3.NewGetAllTimeLeaderboardRankingPublicV3Params()
	params.Namespace = namespace
	params.LeaderboardCode = leaderboardCode
	params.Limit = &limit
	params.Offset = &offset

	resp, err := s.leaderboardDataV3Service.GetAllTimeLeaderboardRankingPublicV3Short(params)
	if err != nil {
		s.logger.WithFields(logrus.Fields{
			"namespace":       namespace,
			"leaderboardCode": leaderboardCode,
			"limit":           limit,
			"offset":          offset,
			"error":           err,
		}).Error("AGS Leaderboard: failed to get leaderboard rankings")
		return nil, fmt.Errorf("failed to get leaderboard rankings: %w", err)
	}

	result := &LeaderboardResult{
		Entries:    make([]LeaderboardEntry, 0),
		TotalCount: 0,
	}

	if resp == nil || resp.Data == nil {
		return result, nil
	}

	// Set total count from the data length
	result.TotalCount = int32(len(resp.Data))

	for i, entry := range resp.Data {
		if entry == nil {
			continue
		}

		userID := ""
		if entry.UserID != nil {
			userID = *entry.UserID
		}

		score := float64(0)
		if entry.Point != nil {
			score = *entry.Point
		}

		leaderboardEntry := LeaderboardEntry{
			Rank:   int32(offset) + int32(i) + 1, // Calculate rank based on offset
			UserID: userID,
			Score:  score,
		}
		result.Entries = append(result.Entries, leaderboardEntry)
	}

	return result, nil
}
