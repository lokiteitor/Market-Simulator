package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

type LoginHelper interface {
	Login(ctx context.Context, req models.LoginRequest) (*models.TokenPair, error)
	Register(ctx context.Context, req models.RegisterAgentRequest) (*models.RegisterAgentResponse, error)
	GetAgentSnapshot(ctx context.Context, eventsLimit int) (*models.AgentSnapshot, error)
}

type SessionData struct {
	Username         string           `json:"username"`
	Password         string           `json:"password"`
	Role             models.AgentRole `json:"role"`
	AgentID          string           `json:"agent_id"`
	AccessToken      string           `json:"access_token"`
	RefreshToken     string           `json:"refresh_token"`
	AccessExpiresAt  time.Time        `json:"access_expires_at"`
	RefreshExpiresAt time.Time        `json:"refresh_expires_at"`
}

type AuthManager struct {
	sync.RWMutex
	username     string
	password     string
	role         models.AgentRole
	agentID      string
	accessToken  string
	refreshToken string
	accessExp    time.Time
	refreshExp   time.Time

	persistPath string
	refresher   func(ctx context.Context, refreshToken string) (*models.TokenPair, error)
}

func NewAuthManager(username, password string, role models.AgentRole, persistPath string) *AuthManager {
	return &AuthManager{
		username:    username,
		password:    password,
		role:        role,
		persistPath: persistPath,
	}
}

func (a *AuthManager) SetRefresher(refresher func(ctx context.Context, refreshToken string) (*models.TokenPair, error)) {
	a.Lock()
	defer a.Unlock()
	a.refresher = refresher
}

func (a *AuthManager) GetAgentID() string {
	a.RLock()
	defer a.RUnlock()
	return a.agentID
}

func (a *AuthManager) GetRole() models.AgentRole {
	a.RLock()
	defer a.RUnlock()
	return a.role
}

func (a *AuthManager) GetUsername() string {
	a.RLock()
	defer a.RUnlock()
	return a.username
}

func (a *AuthManager) GetAccessToken(ctx context.Context) (string, error) {
	a.Lock()
	defer a.Unlock()

	if a.accessToken == "" {
		return "", errors.New("no access token available, authentication required")
	}

	// Check if access token is expired or close to expiration (30 seconds buffer)
	if time.Now().Add(30 * time.Second).After(a.accessExp) {
		if a.refreshToken == "" {
			return "", errors.New("access token expired and no refresh token available")
		}
		if a.refresher == nil {
			return "", errors.New("token refresher function is not configured")
		}

		// Perform refresh
		tokens, err := a.refresher(ctx, a.refreshToken)
		if err != nil {
			return "", fmt.Errorf("failed to auto-refresh access token: %w", err)
		}

		a.accessToken = tokens.AccessToken
		a.refreshToken = tokens.RefreshToken
		a.accessExp = tokens.AccessExpiresAt
		a.refreshExp = tokens.RefreshExpiresAt

		_ = a.saveSessionLocked()
	}

	return a.accessToken, nil
}

// PerformAuth handles the authentication flow: loading from disk, attempting refresh, login or register.
func (a *AuthManager) PerformAuth(ctx context.Context, client LoginHelper, autoRegister bool, requestedCapacities []models.RequestedCapacity) error {
	a.Lock()
	defer a.Unlock()

	// 1. Try to load from persistence
	loaded := a.loadSessionLocked()
	if loaded && a.refreshToken != "" && time.Now().Before(a.refreshExp) {
		// Attempt refresh
		if a.refresher != nil {
			tokens, err := a.refresher(ctx, a.refreshToken)
			if err == nil {
				a.accessToken = tokens.AccessToken
				a.refreshToken = tokens.RefreshToken
				a.accessExp = tokens.AccessExpiresAt
				a.refreshExp = tokens.RefreshExpiresAt
				_ = a.saveSessionLocked()
				return nil
			}
			// Refresh failed; fall through to login/register
		}
	}

	// 2. Refresh failed or no session, attempt Login
	loginReq := models.LoginRequest{
		Username: a.username,
		Password: a.password,
	}

	tokens, err := client.Login(ctx, loginReq)
	if err == nil {
		a.accessToken = tokens.AccessToken
		a.refreshToken = tokens.RefreshToken
		a.accessExp = tokens.AccessExpiresAt
		a.refreshExp = tokens.RefreshExpiresAt

		// Need to get agent snapshot to obtain agent ID and role
		// temporarily unlock to make the API call because client calls will trigger GetAccessToken which needs the read/write lock.
		// Wait, if we are in PerformAuth, c.do(...) will call GetAccessToken, but since we have a.accessToken populated, it will work.
		// However, to avoid deadlock since c.do() will call GetAccessToken which calls a.Lock(), we MUST unlock here before making the API call!
		a.Unlock()
		snapshot, err := client.GetAgentSnapshot(ctx, 1)
		a.Lock()

		if err != nil {
			return fmt.Errorf("failed to retrieve agent snapshot after login: %w", err)
		}

		a.agentID = snapshot.Agent.AgentID
		a.role = snapshot.Agent.Role
		_ = a.saveSessionLocked()
		return nil
	}

	// 3. Login failed; check if we should auto-register
	if autoRegister {
		regReq := models.RegisterAgentRequest{
			Username:            a.username,
			Password:            a.password,
			Role:                a.role,
			RequestedCapacities: requestedCapacities,
		}
		a.Unlock()
		regResp, err := client.Register(ctx, regReq)
		a.Lock()
		if err != nil {
			return fmt.Errorf("auto-registration failed: %w", err)
		}

		a.accessToken = regResp.AccessToken
		a.refreshToken = regResp.RefreshToken
		a.accessExp = regResp.AccessExpiresAt
		a.refreshExp = regResp.RefreshExpiresAt
		a.agentID = regResp.Agent.Agent.AgentID
		a.role = regResp.Agent.Agent.Role

		_ = a.saveSessionLocked()
		return nil
	}

	return fmt.Errorf("authentication failed: %w", err)
}

func (a *AuthManager) loadSessionLocked() bool {
	if a.persistPath == "" {
		return false
	}
	f, err := os.Open(a.persistPath)
	if err != nil {
		return false
	}
	defer f.Close()

	var data SessionData
	if err := json.NewDecoder(f).Decode(&data); err != nil {
		return false
	}

	// Only restore if the username matches
	if data.Username != a.username {
		return false
	}

	a.password = data.Password
	a.role = data.Role
	a.agentID = data.AgentID
	a.accessToken = data.AccessToken
	a.refreshToken = data.RefreshToken
	a.accessExp = data.AccessExpiresAt
	a.refreshExp = data.RefreshExpiresAt
	return true
}

func (a *AuthManager) saveSessionLocked() error {
	if a.persistPath == "" {
		return nil
	}
	// Create directory if not exists
	dir := filepath.Dir(a.persistPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	data := SessionData{
		Username:         a.username,
		Password:         a.password,
		Role:             a.role,
		AgentID:          a.agentID,
		AccessToken:      a.accessToken,
		RefreshToken:     a.refreshToken,
		AccessExpiresAt:  a.accessExp,
		RefreshExpiresAt: a.refreshExp,
	}

	// Write to temp file and rename to avoid partial writes
	tmpFile := a.persistPath + ".tmp"
	f, err := os.OpenFile(tmpFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer func() {
		f.Close()
		_ = os.Remove(tmpFile)
	}()

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(data); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	f.Close()

	return os.Rename(tmpFile, a.persistPath)
}

func (a *AuthManager) ClearSession() error {
	a.Lock()
	defer a.Unlock()
	a.accessToken = ""
	a.refreshToken = ""
	a.accessExp = time.Time{}
	a.refreshExp = time.Time{}
	if a.persistPath != "" {
		return os.Remove(a.persistPath)
	}
	return nil
}
