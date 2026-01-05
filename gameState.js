// gameState.js
export const gameState = {
  screen: "lobby", // lobby | warroom
  turno: 1,
  fase: "planificacion", // planificacion | accion | resolucion
  seed: Date.now(),

  jugadores: [], // se llena al iniciar partida

  // recursos / variables generales del juego
  global: {
    tension: 0, // ejemplo: 0..100
    intel: 0,
  },

  eventosActivos: [], // lista de eventos para resolver en "resolucion"
  historial: [], // log de acciones y eventos
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
