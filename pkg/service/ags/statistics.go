// Copyright (c) 2023-2025 AccelByte Inc. All Rights Reserved.
// This is licensed software from AccelByte Inc, for limitations
// and restrictions contact your company contract manager.

package ags

import (
	"context"
	"fmt"

	"github.com/AccelByte/accelbyte-go-sdk/services-api/pkg/factory"
	"github.com/AccelByte/accelbyte-go-sdk/services-api/pkg/repository"
	"github.com/AccelByte/accelbyte-go-sdk/services-api/pkg/service/social"
	"github.com/AccelByte/accelbyte-go-sdk/social-sdk/pkg/socialclient/user_statistic"
	"github.com/AccelByte/accelbyte-go-sdk/social-sdk/pkg/socialclientmodels"
	"github.com/sirupsen/logrus"
)

// AGSStatisticsService implements StatisticsService using the AccelByte SDK
type AGSStatisticsService struct {
	userStatisticService *social.UserStatisticService
	logger               *logrus.Logger
}

// NewAGSStatisticsService creates a new AGS Statistics service
func NewAGSStatisticsService(
	configRepo repository.ConfigRepository,
	tokenRepo repository.TokenRepository,
	logger *logrus.Logger,
) *AGSStatisticsService {
	socialClient := factory.NewSocialClient(configRepo)
	return &AGSStatisticsService{
		userStatisticService: &social.UserStatisticService{
			Client:           socialClient,
			ConfigRepository: configRepo,
			TokenRepository:  tokenRepo,
		},
		logger: logger,
	}
}

// UpdateUserStatItem updates a user's stat item value using bulk increment
func (s *AGSStatisticsService) UpdateUserStatItem(
	ctx context.Context,
	namespace, userID, statCode string,
	value float64,
) error {
	params := user_statistic.NewBulkIncUserStatItemValue1Params()
	params.Namespace = namespace
	params.UserID = userID
	params.Body = []*socialclientmodels.BulkStatItemInc{
		{
			StatCode: &statCode,
			Inc:      value,
		},
	}

	resp, err := s.userStatisticService.BulkIncUserStatItemValue1Short(params)
	if err != nil {
		s.logger.WithFields(logrus.Fields{
			"namespace": namespace,
			"userID":    userID,
			"statCode":  statCode,
			"value":     value,
			"error":     err,
		}).Error("AGS Statistics: failed to update user stat item")
		return fmt.Errorf("failed to update user stat item: %w", err)
	}

	// resp is []*socialclientmodels.BulkStatOperationResult (slice directly)
	// Check if any operations failed
	if resp != nil {
		for _, result := range resp {
			if result != nil && !result.Success {
				s.logger.WithFields(logrus.Fields{
					"namespace": namespace,
					"userID":    userID,
					"statCode":  statCode,
					"value":     value,
				}).Error("AGS Statistics: stat update operation returned failure")
				return fmt.Errorf("stat update failed for stat code %s", statCode)
			}
		}
	}

	return nil
}
