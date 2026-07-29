package main

import (
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/state"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// Banco de pruebas del energético (ADR-024): el tipo `generacion` con sus tres
// recetas, que comparten el nivel de la instalación como presupuesto de
// concurrencia (ADR-021). Los números son los del catálogo real
// (infra/seed-config.json), porque el fallo que se prueba aquí nace justo de
// ellos: la hidro cuesta ~44 ¢/kWh y las térmicas 27 y 31, así que el precio
// base de la electricidad —el coste MÁS BARATO de producirla— lo fija la
// térmica de carbón y la hidro es siempre la marginal.
const (
	idAgua         = "p-agua"
	idCarbon       = "p-carbon"
	idGas          = "p-gas"
	idElectricidad = "p-electricidad"
	idGeneracion   = "t-generacion"
	idHidro        = "r-hidro"
	idTermicaCarb  = "r-termica-carbon"
	idTermicaGas   = "r-termica-gas"
)

const agenteEnergetico = "a-energetico"

var errSinPatronOro = errors.New("no_gold_standard")

type relojFijo struct{ t time.Time }

func (r relojFijo) Now() time.Time { return r.t }

// libroFalso sirve el mismo top-of-book para cualquier producto: los tests que
// lo usan solo miran la electricidad. Sin patrón oro (BankInfo falla, que es lo
// que hace un despliegue sin banco sembrado).
type libroFalso struct{ ask *models.TopOfBookSide }

func (l *libroFalso) TopOfBook(productID string) (*models.TopOfBook, error) {
	return &models.TopOfBook{ProductID: productID, BestAsk: l.ask}, nil
}

func (l *libroFalso) RecentTrades(string, models.TradesQuery) ([]models.Trade, error) {
	return nil, nil
}

func (l *libroFalso) BankInfo() (*models.BankInfo, error) {
	return nil, errSinPatronOro
}

// CityNeeds solo lo usa la estrategia de las ciudades; aqui no aplica.
func (l *libroFalso) CityNeeds() (*models.CityNeeds, error) { return nil, errSinPatronOro }

func producto(id, key string, cat models.ProductCategory) models.Product {
	return models.Product{ProductID: id, Key: key, Name: key, Unit: "u", Category: cat}
}

func recetaGeneracion(id string, inputs []models.RecipeInput, outQty int64) models.Recipe {
	return models.Recipe{
		RecipeID:        id,
		Name:            id,
		OutputProductID: idElectricidad,
		OutputQtyCent:   outQty,
		// El catálogo declara 3.600 s SIMULADOS; /catalog/recipes los expone ya
		// convertidos a reales (÷ sim_time_factor 5).
		DurationSeconds:     720,
		WageRateCentsPerSec: 2,
		InstallationTypeID:  idGeneracion,
		Inputs:              inputs,
	}
}

// contextoEnergetico arma un estado real (StateManager, no un doble) con el
// catálogo de generación, la instalación ya comprada al nivel dado y el
// inventario que se le pase. Sin ctx.Market: el libro se lee como vacío, que es
// el arranque en frío del mundo.
func contextoEnergetico(t *testing.T, nivel int, inventario map[string]int64, ordenes []models.Order) *strategy.Context {
	t.Helper()

	st := state.NewStateManager()
	st.SetCatalog(
		[]models.Product{
			producto(idAgua, "agua", models.CategoryRawPrimary),
			producto(idCarbon, "carbon", models.CategoryRawPrimary),
			producto(idGas, "gas_natural", models.CategoryRawPrimary),
			producto(idElectricidad, "electricidad", models.CategoryIntermediate),
		},
		[]models.Recipe{
			recetaGeneracion(idHidro, []models.RecipeInput{
				{ProductID: idAgua, QtyRequiredCent: 60000},
			}, 30000),
			recetaGeneracion(idTermicaCarb, []models.RecipeInput{
				{ProductID: idCarbon, QtyRequiredCent: 40000},
				{ProductID: idAgua, QtyRequiredCent: 10000},
			}, 60000),
			recetaGeneracion(idTermicaGas, []models.RecipeInput{
				{ProductID: idGas, QtyRequiredCent: 20000},
				{ProductID: idAgua, QtyRequiredCent: 10000},
			}, 60000),
		},
	)
	st.SetInstallationTypes([]models.InstallationType{{
		InstallationTypeID: idGeneracion,
		Key:                "generacion",
		Name:               "Generación eléctrica",
		Role:               "transformer",
		BasePriceCents:     50000,
		GrowthBps:          17000,
		MaxLevel:           10,
	}})
	// Carbón y gas natural son recursos de yacimiento finito (ADR-023); el agua
	// no. Es la diferencia en la que se apoya prioridadRenovablePrimero.
	st.SetDeposits([]models.Deposit{
		{ProductID: idCarbon, ProductKey: "carbon", QtyInitialCent: 1e9, QtyRemainingCent: 1e9, YieldBps: 10000},
		{ProductID: idGas, ProductKey: "gas_natural", QtyInitialCent: 1e9, QtyRemainingCent: 1e9, YieldBps: 10000},
	})

	inv := make([]models.InventoryPosition, 0, len(inventario))
	for id, qty := range inventario {
		inv = append(inv, models.InventoryPosition{ProductID: id, QtyAvailableCent: qty})
	}
	st.Rebuild(&models.AgentSnapshot{
		Agent: models.AgentPublic{
			AgentID: agenteEnergetico, Username: "energetico_test",
			Role: models.RoleTransformer, Status: models.StatusActive,
		},
		CapitalAvailableCents: 500_000,
		Inventory:             inv,
		ActiveOrders:          ordenes,
		Installations: []models.InstallationStatus{{
			InstallationType: "generacion", Level: nivel,
			Running: 0, AvailableSlots: nivel,
		}},
	})

	return &strategy.Context{
		State:  st,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Rand:   rand.New(rand.NewPCG(1, 2)),
		Clock:  relojFijo{t: time.Unix(1_700_000_000, 0)},
		Config: map[string]interface{}{
			"sim_time_factor": 5.0,
			"prices": map[string]interface{}{
				"agua": 10, "carbon": 20, "gas_natural": 51, "electricidad": 27,
			},
		},
	}
}

// ticksHasta corre la estrategia hasta juntar `n` acciones o agotar los
// intentos: el bot humaniza (skipTickProb, actProb), así que un solo Tick no
// prueba nada.
func ticksHasta(t *testing.T, s *ProducerStrategy, ctx *strategy.Context, intentos int) []actions.Action {
	t.Helper()
	var todas []actions.Action
	for i := 0; i < intentos; i++ {
		todas = append(todas, s.Tick(ctx)...)
	}
	return todas
}

func nuevoEnergetico(t *testing.T, ctx *strategy.Context) *ProducerStrategy {
	t.Helper()
	s := NewEnergeticoStrategy()
	if err := s.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	return s
}

// El fallo original: con agua en el inventario y sin carbón ni gas, el bot no
// arrancaba nada porque las tres recetas se rifaban el único hueco de la
// instalación y las térmicas —que se lo llevaban 2 de cada 3 veces— no tienen
// insumo que consumir.
func TestEnergetico_ProduceHidroCuandoSoloTieneAgua(t *testing.T) {
	ctx := contextoEnergetico(t, 1, map[string]int64{idAgua: 300_000}, nil)
	s := nuevoEnergetico(t, ctx)

	arranques := 0
	for _, act := range ticksHasta(t, s, ctx, 40) {
		start, ok := act.(actions.StartTransformation)
		if !ok {
			continue
		}
		if start.RecipeID != idHidro {
			t.Fatalf("arrancó %s: con solo agua en inventario la única receta viable es la hidro", start.RecipeID)
		}
		arranques++
	}
	if arranques == 0 {
		t.Fatal("no arrancó ninguna ejecución de la hidro teniendo agua y un hueco libre")
	}
}

// El otro lado del mismo fallo: el capital se iba en bids de carbón y gas que
// nadie surte. Con una sola línea, el insumo que se compra es el de la receta
// que puede correr.
func TestEnergetico_SoloCompraElInsumoDeLaRecetaPrioritaria(t *testing.T) {
	ctx := contextoEnergetico(t, 1, nil, nil)
	s := nuevoEnergetico(t, ctx)

	comprado := make(map[string]int64)
	for _, act := range ticksHasta(t, s, ctx, 40) {
		if order, ok := act.(actions.PlaceOrder); ok && order.Side == models.SideBuy {
			comprado[order.ProductID] += order.QtyCent
		}
	}
	if comprado[idAgua] == 0 {
		t.Fatal("no pidió agua: sin ella la hidro nunca arranca")
	}
	if comprado[idCarbon] > 0 || comprado[idGas] > 0 {
		t.Fatalf("inmovilizó capital en insumos de una térmica que no cabe en la única línea: %v", comprado)
	}
}

// Con dos líneas sí caben dos recetas, y la segunda es una térmica.
func TestEnergetico_ConDosLineasAbasteceTambienUnaTermica(t *testing.T) {
	ctx := contextoEnergetico(t, 2, nil, nil)
	s := nuevoEnergetico(t, ctx)

	comprado := make(map[string]int64)
	for _, act := range ticksHasta(t, s, ctx, 40) {
		if order, ok := act.(actions.PlaceOrder); ok && order.Side == models.SideBuy {
			comprado[order.ProductID] += order.QtyCent
		}
	}
	if comprado[idAgua] == 0 {
		t.Fatal("la hidro sigue siendo la prioritaria: tiene que pedir agua")
	}
	if comprado[idCarbon] == 0 && comprado[idGas] == 0 {
		t.Fatal("con dos líneas la segunda receta también debería abastecerse")
	}
}

// El bot se apagaba solo: al listar su electricidad, el mejor ask del libro
// pasaba a ser el suyo y al tick siguiente lo leía como competencia más barata
// que su coste. Le pasa a todo productor marginal, que es justo lo que la hidro
// es por construcción (~44 ¢/kWh contra un fair anclado en 27).
func TestEnergetico_SuPropioAskNoLeParaLaProduccion(t *testing.T) {
	propio := models.Order{
		OrderID: "o-propia", AgentID: agenteEnergetico, ProductID: idElectricidad,
		Side: models.SideSell, QtyOriginalCent: 30000, QtyPendingCent: 30000,
		LimitPriceCents: 33, Status: models.OrderStatusActive,
	}
	ctx := contextoEnergetico(t, 1, map[string]int64{idAgua: 300_000}, []models.Order{propio})
	// El libro trae ese ask propio como mejor oferta: 33 ¢/kWh, muy por debajo
	// del coste de la hidro (~44).
	ctx.Market = &libroFalso{ask: &models.TopOfBookSide{
		OrderID: propio.OrderID, AgentID: agenteEnergetico,
		PriceCents: 33, QtyPendingCent: 30000,
	}}
	s := nuevoEnergetico(t, ctx)

	arranques := 0
	for _, act := range ticksHasta(t, s, ctx, 40) {
		if start, ok := act.(actions.StartTransformation); ok && start.RecipeID == idHidro {
			arranques++
		}
	}
	if arranques == 0 {
		t.Fatal("dejó de producir por su propio ask: sin competencia real, el marginal sigue generando")
	}
}

// El contraste: un ask AJENO por debajo del coste sí es competencia y sí para
// la producción. Es la oferta elástica del productor, que no queremos romper al
// arreglar lo de arriba.
func TestEnergetico_ElAskDeOtroSiParaLaProduccion(t *testing.T) {
	ctx := contextoEnergetico(t, 1, map[string]int64{idAgua: 300_000}, nil)
	ctx.Market = &libroFalso{ask: &models.TopOfBookSide{
		OrderID: "o-ajena", AgentID: "a-otro-generador",
		PriceCents: 20, QtyPendingCent: 300_000,
	}}
	s := nuevoEnergetico(t, ctx)

	for _, act := range ticksHasta(t, s, ctx, 40) {
		if start, ok := act.(actions.StartTransformation); ok {
			t.Fatalf("arrancó %s con otro vendiendo a 20 ¢/kWh: la oferta debe ser elástica", start.RecipeID)
		}
	}
}

// El suelo de venta sale de la receta MÁS BARATA con que el bot sabe hacer el
// producto, no de la última del catálogo. Antes, valorar la electricidad con la
// hidro (44 ¢/kWh) en vez de con la térmica de carbón (27) casi doblaba el
// precio pedido y el bot se quedaba con la producción sin vender.
func TestEnergetico_SueloDeVentaUsaLaRecetaMasBarata(t *testing.T) {
	ctx := contextoEnergetico(t, 1, map[string]int64{idElectricidad: 100_000}, nil)
	s := nuevoEnergetico(t, ctx)

	var precios []int64
	for _, act := range ticksHasta(t, s, ctx, 40) {
		if order, ok := act.(actions.PlaceOrder); ok &&
			order.Side == models.SideSell && order.ProductID == idElectricidad {
			precios = append(precios, order.LimitPriceCents)
		}
	}
	if len(precios) == 0 {
		t.Fatal("no listó la electricidad que tiene en inventario")
	}
	// Coste de la térmica de carbón: (400×20 + 100×10 + 7.200) / 600 = 27 ¢/kWh.
	// El de la hidro es 44: si el suelo saliera de ahí, ningún ask bajaría de 46.
	for _, precio := range precios {
		if precio > 45 {
			t.Fatalf("ask a %d ¢/kWh: el suelo salió de la receta cara, no de la marginal", precio)
		}
	}
}

// prioridadRenovablePrimero no mira nombres de receta (la API no expone la key
// del catálogo): distingue por si algún insumo sale de un yacimiento finito.
func TestPrioridadRenovablePrimero_DistinguePorYacimiento(t *testing.T) {
	ctx := contextoEnergetico(t, 1, nil, nil)
	porID := make(map[string]models.Recipe)
	for _, r := range ctx.State.CatalogRecipes() {
		porID[r.RecipeID] = r
	}

	if p := prioridadRenovablePrimero(ctx, porID[idHidro]); p != 0 {
		t.Fatalf("la hidro (solo agua) debería ir primero, prioridad %d", p)
	}
	for _, id := range []string{idTermicaCarb, idTermicaGas} {
		if p := prioridadRenovablePrimero(ctx, porID[id]); p != 1 {
			t.Fatalf("%s quema un recurso finito: debería ir después, prioridad %d", id, p)
		}
	}
}

func TestAskDeOtro(t *testing.T) {
	s := &ProducerStrategy{agentID: agenteEnergetico}

	if s.askDeOtro(nil) {
		t.Fatal("sin top-of-book no hay competencia que valorar")
	}
	if s.askDeOtro(&models.TopOfBook{ProductID: idElectricidad}) {
		t.Fatal("libro sin asks: no hay competencia")
	}
	propio := &models.TopOfBook{BestAsk: &models.TopOfBookSide{AgentID: agenteEnergetico, PriceCents: 33}}
	if s.askDeOtro(propio) {
		t.Fatal("el mejor ask es nuestro: no es competencia")
	}
	ajeno := &models.TopOfBook{BestAsk: &models.TopOfBookSide{AgentID: "a-otro", PriceCents: 33}}
	if !s.askDeOtro(ajeno) {
		t.Fatal("el mejor ask es de otro agente: sí es competencia")
	}
}
