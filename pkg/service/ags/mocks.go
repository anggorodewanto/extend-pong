// Copyright (c) 2023-2025 AccelByte Inc. All Rights Reserved.
// This is licensed software from AccelByte Inc, for limitations
// and restrictions contact your company contract manager.

package ags

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

// MockStatisticsService is a mock implementation of StatisticsService for testing
type MockStatisticsService struct {
	mu     sync.RWMutex
	scores map[string]map[string]float64 // namespace -> userID -> score
}

// NewMockStatisticsService creates a new mock Statistics service
func NewMockStatisticsService() *MockStatisticsService {
	return &MockStatisticsService{
		scores: make(map[string]map[string]float64),
	}
}

// UpdateUserStatItem stores the stat value in memory (for testing/mock mode)
func (m *MockStatisticsService) UpdateUserStatItem(
	ctx context.Context,
	namespace, userID, statCode string,
	value float64,
) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	key := namespace + ":" + statCode
	if m.scores[key] == nil {
		m.scores[key] = make(map[string]float64)
	}

	// Simulate MAX aggregation - only update if new value is higher
	currentScore := m.scores[key][userID]
	if value > currentScore {
		m.scores[key][userID] = value
		logrus.Infof("[MOCK] Updated stat %s for user %s: %.0f -> %.0f", statCode, userID, currentScore, value)
	} else {
		logrus.Infof("[MOCK] Stat %s for user %s unchanged: %.0f (new: %.0f)", statCode, userID, currentScore, value)
	}

	return nil
}

// GetUserScore returns the stored score for a user (helper for testing)
func (m *MockStatisticsService) GetUserScore(namespace, statCode, userID string) float64 {
	m.mu.RLock()
	defer m.mu.RUnlock()

	key := namespace + ":" + statCode
	if m.scores[key] == nil {
		return 0
	}
	return m.scores[key][userID]
}

// MockLeaderboardService is a mock implementation of LeaderboardService for testing
type MockLeaderboardService struct {
	mu      sync.RWMutex
	entries map[string][]LeaderboardEntry // leaderboardCode -> entries
}

// NewMockLeaderboardService creates a new mock Leaderboard service
func NewMockLeaderboardService() *MockLeaderboardService {
	return &MockLeaderboardService{
		entries: make(map[string][]LeaderboardEntry),
	}
}

// GetAllTimeLeaderboard returns mock leaderboard data
func (m *MockLeaderboardService) GetAllTimeLeaderboard(
	ctx context.Context,
	namespace, leaderboardCode string,
	limit, offset int64,
) (*LeaderboardResult, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	key := namespace + ":" + leaderboardCode
	entries := m.entries[key]

	// Sort entries by score descending
	sortedEntries := make([]LeaderboardEntry, len(entries))
	copy(sortedEntries, entries)
	sort.Slice(sortedEntries, func(i, j int) bool {
		return sortedEntries[i].Score > sortedEntries[j].Score
	})

	// Apply pagination
	start := int(offset)
	if start >= len(sortedEntries) {
		return &LeaderboardResult{
			Entries:    []LeaderboardEntry{},
			TotalCount: int32(len(sortedEntries)),
		}, nil
	}

	end := start + int(limit)
	if end > len(sortedEntries) {
		end = len(sortedEntries)
	}

	// Update ranks based on position
	result := make([]LeaderboardEntry, 0, end-start)
	for i := start; i < end; i++ {
		entry := sortedEntries[i]
		entry.Rank = int32(i + 1)
		result = append(result, entry)
	}

	logrus.Infof("[MOCK] Retrieved leaderboard %s: %d entries (offset=%d, limit=%d)",
		leaderboardCode, len(result), offset, limit)

	return &LeaderboardResult{
		Entries:    result,
		TotalCount: int32(len(sortedEntries)),
	}, nil
}

// AddEntry adds a new entry to the mock leaderboard (helper for testing)
func (m *MockLeaderboardService) AddEntry(namespace, leaderboardCode string, entry LeaderboardEntry) {
	m.mu.Lock()
	defer m.mu.Unlock()

	key := namespace + ":" + leaderboardCode
	if m.entries[key] == nil {
		m.entries[key] = make([]LeaderboardEntry, 0)
	}

	// Update existing entry or add new one
	found := false
	for i, e := range m.entries[key] {
		if e.UserID == entry.UserID {
			if entry.Score > e.Score {
				m.entries[key][i].Score = entry.Score
			}
			found = true
			break
		}
	}

	if !found {
		m.entries[key] = append(m.entries[key], entry)
	}
}

// LinkedMockServices provides linked mock services where statistics updates
// automatically update the leaderboard
type LinkedMockServices struct {
	Statistics  *MockStatisticsService
	Leaderboard *MockLeaderboardService
	namespace   string
	statCode    string
	lbCode      string
}

// NewLinkedMockServices creates linked mock services for integrated testing
func NewLinkedMockServices(namespace, statCode, leaderboardCode string) *LinkedMockServices {
	return &LinkedMockServices{
		Statistics:  NewMockStatisticsService(),
		Leaderboard: NewMockLeaderboardService(),
		namespace:   namespace,
		statCode:    statCode,
		lbCode:      leaderboardCode,
	}
}

// UpdateUserStatItem updates the stat and syncs to leaderboard
func (l *LinkedMockServices) UpdateUserStatItem(
	ctx context.Context,
	namespace, userID, statCode string,
	value float64,
) error {
	err := l.Statistics.UpdateUserStatItem(ctx, namespace, userID, statCode, value)
	if err != nil {
		return err
	}

	// Sync to leaderboard
	currentScore := l.Statistics.GetUserScore(namespace, statCode, userID)
	l.Leaderboard.AddEntry(namespace, l.lbCode, LeaderboardEntry{
		UserID: userID,
		Score:  currentScore,
	})

	return nil
}

// SeedSampleData adds sample leaderboard data for demo purposes
func (l *LinkedMockServices) SeedSampleData() {
	sampleUsers := []struct {
		userID string
		score  float64
	}{
		{"user_champion", 42},
		{"user_pro", 35},
		{"user_skilled", 28},
		{"user_intermediate", 21},
		{"user_beginner", 14},
	}

	for _, u := range sampleUsers {
		l.Leaderboard.AddEntry(l.namespace, l.lbCode, LeaderboardEntry{
			UserID: u.userID,
			Score:  u.score,
		})
	}

	logrus.Infof("[MOCK] Seeded %d sample leaderboard entries", len(sampleUsers))
}

// GetTimestamp returns current timestamp (helper for responses)
func GetTimestamp() int64 {
	return time.Now().Unix()
}
