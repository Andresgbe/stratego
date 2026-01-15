// Estado único (source of truth). La UI se renderiza desde aquí.

export const STRATEGO_ARMY_CONFIG = [
  { rank: "B", label: "💣", count: 6, name: "Bomba" },
  { rank: "10", label: "👮", count: 1, name: "Mariscal" },
  { rank: "9", label: "🎖️", count: 1, name: "General" },
  { rank: "8", label: "🔫", count: 2, name: "Coronel" },
  { rank: "S", label: "🕵️", count: 1, name: "Espía" },
  { rank: "F", label: "🚩", count: 1, name: "Bandera" },
  // Reducido para demo, como venías usando
  { rank: "4", label: "💂", count: 3, name: "Sargento" },
  { rank: "2", label: "🏃", count: 4, name: "Explorador" },
];

export function makeDefaultStrategoInventory() {
  const inv = {};
  for (const p of STRATEGO_ARMY_CONFIG) inv[p.rank] = p.count;
  return inv;
}

export const gameState = {
  screen: "lobby", // lobby | warroom
  turno: 1,
  fase: "planificacion", // planificacion | accion | resolucion (motor de acciones)
  seed: Date.now(),

  jugadores: [], // se llena al iniciar partida

  // recursos / variables generales del juego
  global: {
    tension: 0, // 0..100
    intel: 0,
  },

  eventosActivos: [], // eventos para resolver en "resolucion"
  historial: [], // log de acciones y eventos

  // ===== Stratego (despliegue/board) — Etapa III =====
  stratego: {
    phase: "DEPLOYMENT",
    board: {},
    inventory: {},
    ready: {},
    winnerPlayerId: null,
    turnOwnerId: 1,
    pveAuto: false,
    lastCombat: null,
    ui: {
      selectedCell: null,
    },
  },
};

export function createPlayer({ id, nombre, rol }) {
  return {
    id,
    nombre,
    rol, // ej: "General", "Diplomatico", etc.
    vivo: true,

    recursos: 5,
    moral: 50,
    intel: 0,

    estado: {
      protegido: false,
      penalizacionTurnos: 0,
    },
  };
}

export function resetStrategoState({ playerIds = [1, 2] } = {}) {
  gameState.stratego.phase = "DEPLOYMENT";
  gameState.stratego.board = {};
  gameState.stratego.winnerPlayerId = null;
  gameState.stratego.ui.selectedCell = null;
  gameState.stratego.turnOwnerId = playerIds[0] ?? 1;
  gameState.stratego.lastCombat = null;

  gameState.stratego.inventory = {};
  gameState.stratego.ready = {};

  for (const pid of playerIds) {
    gameState.stratego.inventory[pid] = makeDefaultStrategoInventory();
    gameState.stratego.ready[pid] = false;
  }
}

export function initMatch({ players }) {
  gameState.screen = "warroom";
  gameState.turno = 1;
  gameState.fase = "planificacion";

  gameState.global.tension = 10;
  gameState.global.intel = 0;

  gameState.jugadores = players.map((p, idx) =>
    createPlayer({
      id: idx + 1,
      nombre: p.nombre,
      rol: p.rol,
    })
  );

  gameState.eventosActivos = [];
  gameState.historial = [];

  // Reinicia el modo Stratego (despliegue)
  resetStrategoState({ playerIds: gameState.jugadores.map((j) => j.id) });

  pushLog("system", "Partida iniciada", { jugadores: gameState.jugadores });
}

export function pushLog(type, message, meta = {}) {
  gameState.historial.push({
    ts: new Date().toISOString(),
    turno: gameState.turno,
    fase: gameState.fase,
    type, // system | action | event | error
    message,
    meta,
  });
}
