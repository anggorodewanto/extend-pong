// Copyright (c) 2023-2025 AccelByte Inc. All Rights Reserved.
// This is licensed software from AccelByte Inc, for limitations
// and restrictions contact your company contract manager.

package ags

import "context"

// StatisticsService defines the interface for AGS Statistics operations
type StatisticsService interface {
	// UpdateUserStatItem updates a user's stat item value
	UpdateUserStatItem(ctx context.Context, namespace, userID, statCode string, value float64) error
}

// LeaderboardEntry represents a single entry in the leaderboard
type LeaderboardEntry struct {
	Rank   int32
	UserID string
	Score  float64
}

// LeaderboardResult represents the result of a leaderboard query
type LeaderboardResult struct {
	Entries    []LeaderboardEntry
	TotalCount int32
}

// LeaderboardService defines the interface for AGS Leaderboard operations
type LeaderboardService interface {
	// GetAllTimeLeaderboard retrieves the all-time leaderboard rankings
	GetAllTimeLeaderboard(ctx context.Context, namespace, leaderboardCode string, limit, offset int64) (*LeaderboardResult, error)
}
