package client

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

// StartTransformation initiates a new transformation process.
func (c *Client) StartTransformation(ctx context.Context, req models.StartTransformationRequest) (*models.TransformationProcess, error) {
	var resp models.TransformationProcess
	err := c.do(ctx, http.MethodPost, "/transformations", req, &resp, true)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

type TransformationsFilter struct {
	Statuses []models.ProcessStatus
	RecipeID string
	Since    string
	Limit    int
	Cursor   string
}

// ListTransformations retrieves a list of transformation processes for the agent.
func (c *Client) ListTransformations(ctx context.Context, filter TransformationsFilter) (*models.TransformationPage, error) {
	u, err := url.Parse("/transformations")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	for _, status := range filter.Statuses {
		q.Add("status", string(status))
	}
	if filter.RecipeID != "" {
		q.Set("recipe_id", filter.RecipeID)
	}
	if filter.Since != "" {
		q.Set("since", filter.Since)
	}
	if filter.Limit > 0 {
		q.Set("limit", strconv.Itoa(filter.Limit))
	}
	if filter.Cursor != "" {
		q.Set("cursor", filter.Cursor)
	}
	u.RawQuery = q.Encode()

	var resp models.TransformationPage
	err = c.do(ctx, http.MethodGet, u.String(), nil, &resp, true)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

// GetTransformationDetail retrieves details about a specific transformation process.
func (c *Client) GetTransformationDetail(ctx context.Context, processID string) (*models.TransformationProcessDetail, error) {
	var resp models.TransformationProcessDetail
	err := c.do(ctx, http.MethodGet, fmt.Sprintf("/transformations/%s", processID), nil, &resp, true)
	if err != nil {
		return nil, err
	}
	return &resp, nil
}

// CancelTransformation cancels a transformation process in progress (HTTP 204 No Content).
func (c *Client) CancelTransformation(ctx context.Context, processID string) error {
	return c.do(ctx, http.MethodDelete, fmt.Sprintf("/transformations/%s", processID), nil, nil, true)
}
