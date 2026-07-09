package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

type TokenProvider interface {
	GetAccessToken(ctx context.Context) (string, error)
}

type APIError struct {
	StatusCode int
	Problem    models.Problem
}

func (e *APIError) Error() string {
	if len(e.Problem.Errors) > 0 {
		var subErrors []string
		for _, err := range e.Problem.Errors {
			if err.Field != nil {
				subErrors = append(subErrors, fmt.Sprintf("[%s] %s (%s)", err.Code, err.Message, *err.Field))
			} else {
				subErrors = append(subErrors, fmt.Sprintf("[%s] %s", err.Code, err.Message))
			}
		}
		return fmt.Sprintf("API error (status %d): %s: %s (details: %s)", e.StatusCode, e.Problem.Title, e.Problem.Detail, strings.Join(subErrors, "; "))
	}
	return fmt.Sprintf("API error (status %d): %s: %s", e.StatusCode, e.Problem.Title, e.Problem.Detail)
}

type Client struct {
	baseURL       string
	httpClient    *http.Client
	tokenProvider TokenProvider
}

func NewClient(baseURL string, httpClient *http.Client, tokenProvider TokenProvider) *Client {
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	// Trim trailing slash to ensure path concatenation is clean
	baseURL = strings.TrimSuffix(baseURL, "/")
	return &Client{
		baseURL:       baseURL,
		httpClient:    httpClient,
		tokenProvider: tokenProvider,
	}
}

func (c *Client) do(ctx context.Context, method, path string, body interface{}, res interface{}, authRequired bool) error {
	var bodyReader io.Reader
	if body != nil {
		bodyBytes, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("failed to marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(bodyBytes)
	}

	url := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	if authRequired && c.tokenProvider != nil {
		token, err := c.tokenProvider.GetAccessToken(ctx)
		if err != nil {
			return fmt.Errorf("failed to get access token: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBytes, _ := io.ReadAll(resp.Body)
		var prob models.Problem
		if err := json.Unmarshal(respBytes, &prob); err == nil && prob.Title != "" {
			return &APIError{
				StatusCode: resp.StatusCode,
				Problem:    prob,
			}
		}
		return fmt.Errorf("request failed with status %d: %s", resp.StatusCode, string(respBytes))
	}

	if res != nil && resp.StatusCode != http.StatusNoContent {
		respBytes, err := io.ReadAll(resp.Body)
		if err != nil {
			return fmt.Errorf("failed to read response body: %w", err)
		}
		if err := json.Unmarshal(respBytes, res); err != nil {
			return fmt.Errorf("failed to unmarshal response: %w (body: %s)", err, string(respBytes))
		}
	}

	return nil
}

type errWrapper string

func (e errWrapper) Error() string { return string(e) }
