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

// Banco de pruebas con los números del catálogo real (infra/seed-config.json),
// porque el comportamiento que se prueba nace justo de ellos: la hidro cuesta
// ~44 ¢/kWh y las térmicas 27 y 31, así que el precio base de la electricidad
// —el coste MÁS BARATO de producirla— lo fija la térmica de carbón y la hidro es
// siempre la generadora marginal.
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

const agenteHidro = "a-hidro"

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

func (l *libroFalso) BankInfo() (*models.BankInfo, error) { return nil, errSinPatronOro }

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

type opciones struct {
	nivel      int
	inventario map[string]int64
	ordenes    []models.Order
	capital    int64
	// sinDepositos simula el arranque en el que GET /catalog/deposits falla: el
	// engine sigue adelante asumiendo recursos infinitos.
	sinDepositos bool
}

// contextoHidro arma un estado real (StateManager, no un doble) con el catálogo
// de generación completo —hidro y las dos térmicas—, la central al nivel dado y
// el inventario que se le pase. Sin ctx.Market el libro se lee vacío, que es el
// arranque en frío del mundo.
func contextoHidro(t *testing.T, o opciones) *strategy.Context {
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
	if !o.sinDepositos {
		// Carbón y gas natural salen de yacimiento finito (ADR-023); el agua no.
		st.SetDeposits([]models.Deposit{
			{ProductID: idCarbon, ProductKey: "carbon", QtyInitialCent: 1e9, QtyRemainingCent: 1e9, YieldBps: 10000},
			{ProductID: idGas, ProductKey: "gas_natural", QtyInitialCent: 1e9, QtyRemainingCent: 1e9, YieldBps: 10000},
		})
	}

	inv := make([]models.InventoryPosition, 0, len(o.inventario))
	for id, qty := range o.inventario {
		inv = append(inv, models.InventoryPosition{ProductID: id, QtyAvailableCent: qty})
	}
	capital := o.capital
	if capital == 0 {
		capital = 500_000
	}
	instalaciones := []models.InstallationStatus{}
	if o.nivel > 0 {
		instalaciones = append(instalaciones, models.InstallationStatus{
			InstallationType: "generacion", Level: o.nivel,
			Running: 0, AvailableSlots: o.nivel,
		})
	}
	st.Rebuild(&models.AgentSnapshot{
		Agent: models.AgentPublic{
			AgentID: agenteHidro, Username: "hidro_test",
			Role: models.RoleTransformer, Status: models.StatusActive,
		},
		CapitalAvailableCents: capital,
		Inventory:             inv,
		ActiveOrders:          o.ordenes,
		Installations:         instalaciones,
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

func nuevaHidro(t *testing.T, ctx *strategy.Context) *HidroStrategy {
	t.Helper()
	s := NewHidroStrategy()
	if err := s.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	return s
}

// ticksHasta corre la estrategia varias veces: el bot humaniza (skipTickProb,
// actProb), así que un solo Tick no prueba nada.
func ticksHasta(t *testing.T, s *HidroStrategy, ctx *strategy.Context, intentos int) []actions.Action {
	t.Helper()
	var todas []actions.Action
	for i := 0; i < intentos; i++ {
		todas = append(todas, s.Tick(ctx)...)
	}
	return todas
}

// Lo que define a este bot: de las tres recetas de `generacion` se queda solo
// con la que no quema un recurso finito.
func TestInitialize_SoloSeQuedaConLaRecetaRenovable(t *testing.T) {
	ctx := contextoHidro(t, opciones{nivel: 1})
	s := nuevaHidro(t, ctx)

	if len(s.recetas) != 1 {
		t.Fatalf("seleccionó %d recetas, esperaba solo la hidro: %+v", len(s.recetas), s.recetas)
	}
	if s.recetas[0].RecipeID != idHidro {
		t.Fatalf("seleccionó %s en vez de la hidro", s.recetas[0].RecipeID)
	}
}

// La lista blanca de insumos manda sobre el criterio del yacimiento: si
// `GET /catalog/deposits` falla al arrancar, el engine sigue adelante asumiendo
// recursos infinitos y el criterio del yacimiento solo dejaría pasar las
// térmicas como si fueran renovables.
func TestInitialize_SinYacimientosSigueDescartandoLasTermicas(t *testing.T) {
	ctx := contextoHidro(t, opciones{nivel: 1, sinDepositos: true})
	s := nuevaHidro(t, ctx)

	if len(s.recetas) != 1 || s.recetas[0].RecipeID != idHidro {
		t.Fatalf("sin yacimientos cargados se coló una térmica: %+v", s.recetas)
	}
}

// Un catálogo sin generación renovable deja al bot sin nada que hacer: mejor
// abortar el arranque que sostener una conexión girando en vacío.
func TestInitialize_FallaSiNoHayGeneracionRenovable(t *testing.T) {
	ctx := contextoHidro(t, opciones{nivel: 1})
	s := NewHidroStrategy()
	s.renovables = map[string]bool{"nada_de_esto": true}
	if err := s.Initialize(ctx); err == nil {
		t.Fatal("Initialize debería fallar cuando ninguna receta pasa la lista blanca")
	}
}

// El agua es lo único que compra. El fallo que esto vigila es el del generalista:
// repartir el capital entre agua, carbón y gas y quedarse con bids de dos
// insumos que no va a consumir nunca.
func TestTick_SoloCompraAgua(t *testing.T) {
	ctx := contextoHidro(t, opciones{nivel: 1})
	s := nuevaHidro(t, ctx)

	comprado := make(map[string]int64)
	for _, act := range ticksHasta(t, s, ctx, 40) {
		if o, ok := act.(actions.PlaceOrder); ok && o.Side == models.SideBuy {
			comprado[o.ProductID] += o.QtyCent
		}
	}
	if comprado[idAgua] == 0 {
		t.Fatal("no pidió agua: sin ella la central nunca turbina")
	}
	if comprado[idCarbon] > 0 || comprado[idGas] > 0 {
		t.Fatalf("inmovilizó capital en combustible fósil que no consume: %v", comprado)
	}
}

// Con agua en el almacén y una línea libre, turbina.
func TestTick_TurbinaConAgua(t *testing.T) {
	ctx := contextoHidro(t, opciones{nivel: 1, inventario: map[string]int64{idAgua: 300_000}})
	s := nuevaHidro(t, ctx)

	arranques := 0
	for _, act := range ticksHasta(t, s, ctx, 40) {
		start, ok := act.(actions.StartTransformation)
		if !ok {
			continue
		}
		if start.RecipeID != idHidro {
			t.Fatalf("arrancó %s: esta central solo genera con la hidro", start.RecipeID)
		}
		arranques++
	}
	if arranques == 0 {
		t.Fatal("no turbinó teniendo agua y una línea libre")
	}
}

// La central nace sin instalación (ADR-021) y tiene que comprarla con su
// capital semilla antes de poder generar nada.
func TestTick_CompraLaCentralSiNoLaTiene(t *testing.T) {
	ctx := contextoHidro(t, opciones{nivel: 0, capital: 400_000})
	s := nuevaHidro(t, ctx)

	for _, act := range ticksHasta(t, s, ctx, 40) {
		if buy, ok := act.(actions.AcquireInstallation); ok {
			if buy.InstallationType != "generacion" {
				t.Fatalf("compró la instalación %q", buy.InstallationType)
			}
			if buy.ExpectedCurrentLevel != 0 {
				t.Fatalf("expected_current_level %d en la compra inicial", buy.ExpectedCurrentLevel)
			}
			return
		}
	}
	t.Fatal("nunca compró la central: sin instalación no puede generar")
}

// El corazón de la especialización. El productor genérico para en cuanto alguien
// vende por debajo de coste+margen, y con una térmica de carbón en el libro
// (27 ¢/kWh contra los ~44 de la hidro) eso apaga la central casi siempre. Aquí
// se sigue generando mientras el precio ajeno cubra el coste variable.
func TestTick_NoSeApagaPorUnaTermicaMasBarataQueSuMargen(t *testing.T) {
	ctx := contextoHidro(t, opciones{nivel: 1, inventario: map[string]int64{idAgua: 300_000}})
	// 45 ¢/kWh: por debajo de coste+margen de la hidro, por encima de su coste
	// variable (~44). Un generalista se habría apagado.
	ctx.Market = &libroFalso{ask: &models.TopOfBookSide{
		OrderID: "o-termica", AgentID: "a-otro-generador",
		PriceCents: 45, QtyPendingCent: 300_000,
	}}
	s := nuevaHidro(t, ctx)

	arranques := 0
	for _, act := range ticksHasta(t, s, ctx, 40) {
		if start, ok := act.(actions.StartTransformation); ok && start.RecipeID == idHidro {
			arranques++
		}
	}
	if arranques == 0 {
		t.Fatal("se apagó con un ask que aún cubría su coste variable")
	}
}

// El otro lado: por debajo del coste VARIABLE generar destruye capital, y ahí sí
// para. Sin este límite el bot se arruina generando contra un mercado hundido.
func TestTick_ParaCuandoElPrecioNoCubreElCosteVariable(t *testing.T) {
	ctx := contextoHidro(t, opciones{nivel: 1, inventario: map[string]int64{idAgua: 300_000}})
	ctx.Market = &libroFalso{ask: &models.TopOfBookSide{
		OrderID: "o-barata", AgentID: "a-otro-generador",
		PriceCents: 20, QtyPendingCent: 300_000,
	}}
	s := nuevaHidro(t, ctx)

	for _, act := range ticksHasta(t, s, ctx, 40) {
		if start, ok := act.(actions.StartTransformation); ok {
			t.Fatalf("arrancó %s con otro vendiendo a 20 ¢/kWh: eso es generar a pérdida", start.RecipeID)
		}
	}
}

// El bot se apagaba solo en bots-v1: al listar su electricidad, el mejor ask del
// libro pasaba a ser el suyo y al tick siguiente lo leía como competencia más
// barata que su coste. Aquí no puede pasar.
func TestTick_SuPropioAskNoLeParaLaGeneracion(t *testing.T) {
	propia := models.Order{
		OrderID: "o-propia", AgentID: agenteHidro, ProductID: idElectricidad,
		Side: models.SideSell, QtyOriginalCent: 30000, QtyPendingCent: 30000,
		LimitPriceCents: 33, Status: models.OrderStatusActive,
	}
	ctx := contextoHidro(t, opciones{
		nivel:      1,
		inventario: map[string]int64{idAgua: 300_000},
		ordenes:    []models.Order{propia},
	})
	ctx.Market = &libroFalso{ask: &models.TopOfBookSide{
		OrderID: propia.OrderID, AgentID: agenteHidro,
		PriceCents: 33, QtyPendingCent: 30000,
	}}
	s := nuevaHidro(t, ctx)

	arranques := 0
	for _, act := range ticksHasta(t, s, ctx, 40) {
		if start, ok := act.(actions.StartTransformation); ok && start.RecipeID == idHidro {
			arranques++
		}
	}
	if arranques == 0 {
		t.Fatal("dejó de generar por su propio ask")
	}
}

// Como el gate de precio casi nunca apaga esta central, lo que la apaga es el
// almacén: sin este freno seguiría pagando salarios contra un stock invendible.
func TestTick_ParaCuandoLaElectricidadNoSeVende(t *testing.T) {
	// 6 ejecuciones por línea × 30.000 es el tope; se le da mucho más.
	ctx := contextoHidro(t, opciones{
		nivel:      1,
		inventario: map[string]int64{idAgua: 3_000_000, idElectricidad: 5_000_000},
	})
	s := nuevaHidro(t, ctx)

	for _, act := range ticksHasta(t, s, ctx, 40) {
		if start, ok := act.(actions.StartTransformation); ok {
			t.Fatalf("arrancó %s con el almacén desbordado de electricidad sin vender", start.RecipeID)
		}
	}
}

// Vende su electricidad, nunca el agua: el agua es insumo comprado, y rematarla
// dejaría la central parada mañana.
func TestTick_VendeElectricidadYNuncaElAgua(t *testing.T) {
	ctx := contextoHidro(t, opciones{
		nivel:      1,
		inventario: map[string]int64{idAgua: 300_000, idElectricidad: 100_000},
	})
	s := nuevaHidro(t, ctx)

	ventas := make(map[string]int64)
	for _, act := range ticksHasta(t, s, ctx, 40) {
		if o, ok := act.(actions.PlaceOrder); ok && o.Side == models.SideSell {
			ventas[o.ProductID] += o.QtyCent
		}
	}
	if ventas[idElectricidad] == 0 {
		t.Fatal("no listó la electricidad que tiene en inventario")
	}
	if ventas[idAgua] > 0 {
		t.Fatalf("vendió %d de agua: es su insumo, no su producción", ventas[idAgua])
	}
}

// El suelo de venta sale del coste de LA HIDRO (~44 ¢/kWh), no del fair de la
// electricidad (27, anclado en la térmica de carbón): esta central no puede
// vender por debajo de lo que le cuesta reponer el kWh.
func TestTick_NoVendePorDebajoDeSuCoste(t *testing.T) {
	ctx := contextoHidro(t, opciones{
		nivel:      1,
		inventario: map[string]int64{idElectricidad: 100_000},
	})
	s := nuevaHidro(t, ctx)

	precios := 0
	for _, act := range ticksHasta(t, s, ctx, 40) {
		o, ok := act.(actions.PlaceOrder)
		if !ok || o.Side != models.SideSell || o.ProductID != idElectricidad {
			continue
		}
		precios++
		// Coste de la hidro: (600×10 + 7.200) / 300 = 44 ¢/kWh. Sin
		// liqCapEfectivo, el modo liquidación de SellAtMarket recortaba el suelo
		// a fair×liqCap (27 × 1,2-1,5 ≈ 32-40) y la central remataba su
		// generación cada tick.
		if o.LimitPriceCents < 44 {
			t.Fatalf("ask a %d ¢/kWh: por debajo del coste de generar", o.LimitPriceCents)
		}
	}
	if precios == 0 {
		t.Fatal("no listó nada")
	}
}

func TestAskDeOtro(t *testing.T) {
	s := &HidroStrategy{agentID: agenteHidro}

	if s.askDeOtro(nil) {
		t.Fatal("sin top-of-book no hay competencia que valorar")
	}
	if s.askDeOtro(&models.TopOfBook{ProductID: idElectricidad}) {
		t.Fatal("libro sin asks: no hay competencia")
	}
	propio := &models.TopOfBook{BestAsk: &models.TopOfBookSide{AgentID: agenteHidro, PriceCents: 33}}
	if s.askDeOtro(propio) {
		t.Fatal("el mejor ask es nuestro: no es competencia")
	}
	ajeno := &models.TopOfBook{BestAsk: &models.TopOfBookSide{AgentID: "a-otro", PriceCents: 33}}
	if !s.askDeOtro(ajeno) {
		t.Fatal("el mejor ask es de otro agente: sí es competencia")
	}
}
