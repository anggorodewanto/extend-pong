// Copyright (c) 2023-2025 AccelByte Inc. All Rights Reserved.
// This is licensed software from AccelByte Inc, for limitations
// and restrictions contact your company contract manager.

package ags

import (
	"context"
	"fmt"

	"github.com/AccelByte/accelbyte-go-sdk/leaderboard-sdk/pkg/leaderboardclient/leaderboard_data"
	"github.com/AccelByte/accelbyte-go-sdk/services-api/pkg/factory"
	"github.com/AccelByte/accelbyte-go-sdk/services-api/pkg/repository"
	"github.com/AccelByte/accelbyte-go-sdk/services-api/pkg/service/leaderboard"
)

// AGSLeaderboardService implements LeaderboardService using the AccelByte SDK
type AGSLeaderboardService struct {
	leaderboardDataService *leaderboard.LeaderboardDataService
}

// NewAGSLeaderboardService creates a new AGS Leaderboard service
func NewAGSLeaderboardService(
	configRepo repository.ConfigRepository,
	tokenRepo repository.TokenRepository,
) *AGSLeaderboardService {
	leaderboardClient := factory.NewLeaderboardClient(configRepo)
	return &AGSLeaderboardService{
		leaderboardDataService: &leaderboard.LeaderboardDataService{
			Client:           leaderboardClient,
			ConfigRepository: configRepo,
			TokenRepository:  tokenRepo,
		},
	}
}

// GetAllTimeLeaderboard retrieves the all-time leaderboard rankings
func (s *AGSLeaderboardService) GetAllTimeLeaderboard(
	ctx context.Context,
	namespace, leaderboardCode string,
	limit, offset int64,
) (*LeaderboardResult, error) {
	params := leaderboard_data.NewGetAllTimeLeaderboardRankingPublicV1Params()
	params.Namespace = namespace
	params.LeaderboardCode = leaderboardCode
	params.Limit = &limit
	params.Offset = &offset

	resp, err := s.leaderboardDataService.GetAllTimeLeaderboardRankingPublicV1Short(params)
	if err != nil {
		return nil, fmt.Errorf("failed to get leaderboard rankings: %w", err)
	}

	result := &LeaderboardResult{
		Entries:    make([]LeaderboardEntry, 0),
		TotalCount: 0,
	}

	// resp is *leaderboard_data.GetAllTimeLeaderboardRankingPublicV1Response
	// resp.Data is []*leaderboardclientmodels.ModelsUserPoint
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
