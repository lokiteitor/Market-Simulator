package websocket

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/util"
)

type TokenProvider interface {
	GetAccessToken(ctx context.Context) (string, error)
}

// TokenInvalidator is implemented by token providers that can discard a
// cached access token the server no longer accepts (see client.TokenInvalidator).
type TokenInvalidator interface {
	InvalidateAccessToken()
}

// closeUnauthorized is the application close code the backend sends when the
// handshake token is invalid (contract §12). The backend verifies the token
// after the upgrade, so an invalid token shows up as this close code on the
// first read rather than as an HTTP 401 on the dial.
const closeUnauthorized = 4401

type wsEnvelope struct {
	Type       string          `json:"type"`
	OccurredAt time.Time       `json:"occurred_at"`
	Payload    json.RawMessage `json:"payload"`
}

type Client struct {
	sync.Mutex
	wsURL         string
	tokenProvider TokenProvider
	logger        *slog.Logger
	conn          *websocket.Conn
	eventChan     chan events.Event
	rawEventChan  chan events.Event
	ctx           context.Context
	cancel        context.CancelFunc
	running       bool
	backoff       *util.Backoff
}

func NewClient(wsURL string, tokenProvider TokenProvider, logger *slog.Logger) *Client {
	if logger == nil {
		logger = slog.Default()
	}
	// Convert HTTP/S to WS/S if necessary
	if strings.HasPrefix(wsURL, "https://") {
		wsURL = "wss://" + strings.TrimPrefix(wsURL, "https://")
	} else if strings.HasPrefix(wsURL, "http://") {
		wsURL = "ws://" + strings.TrimPrefix(wsURL, "http://")
	}
	return &Client{
		wsURL:         wsURL,
		tokenProvider: tokenProvider,
		logger:        logger.With("system", "websocket"),
		eventChan:     make(chan events.Event, 10000),
		rawEventChan:  make(chan events.Event, 1000),
		backoff:       util.NewBackoff(1*time.Second, 30*time.Second, 2.0),
	}
}

func (c *Client) Events() <-chan events.Event {
	return c.eventChan
}

func (c *Client) Start(ctx context.Context) error {
	c.Lock()
	if c.running {
		c.Unlock()
		return errors.New("websocket client is already running")
	}
	runCtx, cancel := context.WithCancel(ctx)
	c.ctx = runCtx
	c.cancel = cancel
	c.running = true
	c.Unlock()

	go c.bufferLoop(runCtx)
	go c.connectionLoop(runCtx)
	return nil
}

func (c *Client) Stop() {
	c.Lock()
	if !c.running {
		c.Unlock()
		return
	}
	c.running = false
	if c.cancel != nil {
		c.cancel()
	}
	if c.conn != nil {
		c.conn.Close()
	}
	c.Unlock()
}

func (c *Client) bufferLoop(ctx context.Context) {
	c.logger.Debug("websocket event buffer loop started")
	defer c.logger.Debug("websocket event buffer loop exiting")
	var queue []events.Event
	for {
		if len(queue) == 0 {
			select {
			case ev, ok := <-c.rawEventChan:
				if !ok {
					return
				}
				queue = append(queue, ev)
			case <-ctx.Done():
				return
			}
		} else {
			select {
			case ev, ok := <-c.rawEventChan:
				if !ok {
					return
				}
				queue = append(queue, ev)
			case c.eventChan <- queue[0]:
				queue = queue[1:]
			case <-ctx.Done():
				return
			}
		}
	}
}

func (c *Client) connectionLoop(ctx context.Context) {
	attempt := 0
	for {
		c.Lock()
		running := c.running
		c.Unlock()

		if !running || ctx.Err() != nil {
			c.logger.Info("websocket connection loop exiting")
			return
		}

		// Get access token for this connection attempt
		token, err := c.tokenProvider.GetAccessToken(ctx)
		if err != nil {
			c.logger.Error("websocket failed to get access token for connection", "error", err)
			// Wait and retry
			attempt++
			if err := c.backoff.Sleep(ctx, attempt); err != nil {
				return
			}
			continue
		}

		// Construct URL with ?access_token=...
		u, err := url.Parse(c.wsURL)
		if err != nil {
			c.logger.Error("websocket invalid URL configuration", "url", c.wsURL, "error", err)
			return
		}
		q := u.Query()
		q.Set("access_token", token)
		u.RawQuery = q.Encode()

		c.logger.Info("connecting to websocket", "url", c.wsURL)
		dialer := websocket.DefaultDialer
		dialer.HandshakeTimeout = 10 * time.Second

		conn, resp, err := dialer.DialContext(ctx, u.String(), nil)
		if err != nil {
			if resp != nil && resp.StatusCode == http.StatusUnauthorized {
				c.logger.Warn("websocket handshake rejected as unauthorized, discarding cached access token")
				c.invalidateToken()
			}
			c.logger.Error("websocket dial failed", "error", err)
			attempt++
			if err := c.backoff.Sleep(ctx, attempt); err != nil {
				return
			}
			continue
		}

		c.Lock()
		c.conn = conn
		c.Unlock()

		attempt = 0 // reset backoff on successful connection
		c.logger.Info("websocket connected successfully")

		// Dispatch connected event to channel
		select {
		case c.rawEventChan <- events.WSConnected{ConnectedAt: time.Now()}:
		default:
		}

		// Run the read loop
		readErr := c.readLoop(ctx, conn)
		if websocket.IsCloseError(readErr, closeUnauthorized) {
			c.logger.Warn("websocket closed as unauthorized, discarding cached access token")
			c.invalidateToken()
		}

		c.Lock()
		if c.conn == conn {
			c.conn = nil
		}
		c.Unlock()
	}
}

func (c *Client) invalidateToken() {
	if inv, ok := c.tokenProvider.(TokenInvalidator); ok {
		inv.InvalidateAccessToken()
	}
}

// readLoop reads until the connection fails and returns the read error so the
// connection loop can distinguish an auth rejection from a plain disconnect.
func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn) error {
	// Set read deadline and handle heartbeats
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(appData string) error {
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			c.logger.Error("websocket read error", "error", err)
			return err
		}

		event, err := c.parseWSEvent(message)
		if err != nil {
			c.logger.Warn("failed to parse websocket message", "error", err, "message", string(message))
			continue
		}

		select {
		case c.rawEventChan <- event:
		case <-ctx.Done():
			return nil
		}
	}
}

func (c *Client) parseWSEvent(msg []byte) (events.Event, error) {
	var env wsEnvelope
	if err := json.Unmarshal(msg, &env); err != nil {
		return nil, fmt.Errorf("failed to unmarshal ws envelope: %w", err)
	}

	var ev events.Event
	switch env.Type {
	case "order_executed":
		var p events.OrderExecuted
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return nil, err
		}
		p.ExecutedAt = env.OccurredAt
		ev = p
	case "order_expired":
		var p events.OrderExpired
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return nil, err
		}
		p.ExpiredAt = env.OccurredAt
		ev = p
	case "order_cancelled":
		var p events.OrderCancelled
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return nil, err
		}
		p.CancelledAt = env.OccurredAt
		ev = p
	case "transformation_completed":
		var p events.TransformationCompleted
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return nil, err
		}
		p.CompletedAt = env.OccurredAt
		ev = p
	case "bankruptcy_notice":
		var p events.BankruptcyNotice
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return nil, err
		}
		p.BankruptAt = env.OccurredAt
		ev = p
	case "agent_joined":
		var p events.AgentJoined
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return nil, err
		}
		p.JoinedAt = env.OccurredAt
		ev = p
	case "agent_bankrupt":
		var p events.AgentBankrupt
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return nil, err
		}
		p.BankruptAt = env.OccurredAt
		ev = p
	case "trade_printed":
		var p events.TradePrinted
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return nil, err
		}
		ev = p
	case "gold_converted":
		var p events.GoldConverted
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return nil, err
		}
		ev = p
	default:
		return nil, fmt.Errorf("unknown event type: %s", env.Type)
	}

	return ev, nil
}
