// Estado único (source of truth). La UI se renderiza desde aquí.

export const STRATEGO_ARMY_CONFIG = [
  // Classic Stratego (40 piezas) – ranks esperados por el backend
  { rank: "0", label: "🚩", count: 1, name: "Bandera" },       // FLAG
  { rank: "11", label: "💣", count: 6, name: "Bomba" },        // BOMB
  { rank: "10", label: "🕵️", count: 1, name: "Espía" },        // SPY
  { rank: "9", label: "🏃", count: 8, name: "Explorador" },    // SCOUT
  { rank: "8", label: "⛏️", count: 5, name: "Minero" },        // MINER
  { rank: "7", label: "🎖️", count: 4, name: "Sargento" },      // SERGEANT
  { rank: "6", label: "🎖️", count: 4, name: "Teniente" },      // LIEUTENANT
  { rank: "5", label: "🎖️", count: 4, name: "Capitán" },       // CAPTAIN
  { rank: "4", label: "🎖️", count: 3, name: "Mayor" },         // MAJOR
  { rank: "3", label: "🎖️", count: 2, name: "Coronel" },       // COLONEL
  { rank: "2", label: "🎖️", count: 1, name: "General" },       // GENERAL
  { rank: "1", label: "👑", count: 1, name: "Mariscal" },       // MARSHAL
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

  // ===== Stratego (despliegue/board) =====
  stratego: {
    phase: "DEPLOYMENT", // DEPLOYMENT | HANDSHAKE | BATTLE | GAME_OVER
    board: {},
    inventory: {},
    ready: {},

    // Networking PvP (se llena al entrar a una partida online)
    net: {
      active: false,
      matchId: null,
      mode: null, // opcional si lo usas
      protocolMode: null, // 'FETCH_FIRST' | 'SOCKET_FIRST'
      team: null, // 'RED' | 'BLUE'
      localPlayerId: 1, // 1 si RED, 2 si BLUE
      opponentUsername: null,
    },

    winnerPlayerId: null,
    gameOverReason: null,

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
  gameState.stratego.gameOverReason = null;
  gameState.stratego.ui.selectedCell = null;
  gameState.stratego.turnOwnerId = playerIds[0] ?? 1;
  gameState.stratego.lastCombat = null;

  gameState.stratego.inventory = {};
  gameState.stratego.ready = {};

  // Reset net context (por defecto OFF)
  gameState.stratego.net.active = false;
  gameState.stratego.net.matchId = null;
  gameState.stratego.net.mode = null;
  gameState.stratego.net.protocolMode = null;
  gameState.stratego.net.team = null;
  gameState.stratego.net.localPlayerId = playerIds[0] ?? 1;
  gameState.stratego.net.opponentUsername = null;

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
