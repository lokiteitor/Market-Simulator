package websocket

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
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

// subscribeProductsMsg es el ÚNICO mensaje cliente→servidor del canal
// (contrato §12): declara los productos cuyo trade_printed quiere recibir
// esta conexión. Reemplaza la declaración anterior; "*" = todos.
type subscribeProductsMsg struct {
	Type       string   `json:"type"`
	ProductIDs []string `json:"product_ids"`
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
	// Suscripción de tape vigente (fan-out selectivo): se re-envía tras cada
	// (re)conexión porque vive en la conexión, no en el agente.
	products    []string
	productsSet bool
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

// SetProductSubscriptions declara los productos cuyo trade_printed quiere
// recibir el cliente ("*" = todos). El servidor NO entrega tape sin
// suscripción declarada. Puede llamarse antes de Start o en caliente; el
// cliente la re-envía automáticamente tras cada reconexión.
func (c *Client) SetProductSubscriptions(productIDs []string) {
	c.Lock()
	c.products = append([]string(nil), productIDs...)
	c.productsSet = true
	conn := c.conn
	c.Unlock()
	if conn != nil {
		if err := c.sendProductSubscriptions(conn); err != nil {
			c.logger.Warn("websocket failed to send product subscriptions", "error", err)
		}
	}
}

// sendProductSubscriptions escribe la suscripción vigente en la conexión.
// Toma el lock para serializar los frames de datos (gorilla admite un solo
// escritor concurrente; los WriteControl del pong van aparte y son seguros).
func (c *Client) sendProductSubscriptions(conn *websocket.Conn) error {
	c.Lock()
	defer c.Unlock()
	if !c.productsSet {
		return nil
	}
	msg := subscribeProductsMsg{Type: "subscribe_products", ProductIDs: c.products}
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.WriteJSON(msg)
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
			// Durante el apagado el contexto muere con la request en vuelo.
			if ctx.Err() != nil {
				c.logger.Debug("websocket token request interrupted by shutdown", "error", err)
				return
			}
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
			// Durante el apagado el contexto muere con el dial en vuelo.
			if ctx.Err() != nil {
				c.logger.Debug("websocket dial interrupted by shutdown", "error", err)
				return
			}
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

		// Re-declarar la suscripción de tape: vive en la conexión y el
		// servidor no entrega trade_printed hasta recibirla.
		if err := c.sendProductSubscriptions(conn); err != nil {
			c.logger.Warn("websocket failed to send product subscriptions", "error", err)
		}

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

// readDeadline debe superar 2× el heartbeat del servidor (PING cada 30s):
// tolera perder dos pings seguidos antes de dar la conexión por muerta.
const readDeadline = 90 * time.Second

// readLoop reads until the connection fails and returns the read error so the
// connection loop can distinguish an auth rejection from a plain disconnect.
func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn) error {
	// El heartbeat lo envía el SERVIDOR (PING cada 30s). El deadline se
	// refresca al recibir cada PING; al sobreescribir el ping handler hay que
	// responder el PONG a mano (se pierde el handler por defecto de gorilla).
	_ = conn.SetReadDeadline(time.Now().Add(readDeadline))
	conn.SetPingHandler(func(appData string) error {
		_ = conn.SetReadDeadline(time.Now().Add(readDeadline))
		err := conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(10*time.Second))
		if err == websocket.ErrCloseSent {
			return nil
		}
		return err
	})

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			// Stop() cancela el contexto y cierra la conexión: ese despertar
			// del ReadMessage es un apagado normal, no un error de red.
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				c.logger.Debug("websocket read interrupted by shutdown", "error", err)
			} else {
				c.logger.Error("websocket read error", "error", err)
			}
			return err
		}
		_ = conn.SetReadDeadline(time.Now().Add(readDeadline))

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
	case "city_income":
		var p events.CityIncome
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return nil, err
		}
		p.ReceivedAt = env.OccurredAt
		ev = p
	case "installation_purchased":
		var p events.InstallationPurchased
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			return nil, err
		}
		p.PurchasedAt = env.OccurredAt
		ev = p
	default:
		return nil, fmt.Errorf("unknown event type: %s", env.Type)
	}

	return ev, nil
}
