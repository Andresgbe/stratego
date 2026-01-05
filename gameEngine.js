import { gameState, pushLog } from "./gameState.js";
import { getActionById } from "./actions.js";
import { pickRandomEvent } from "./events.js";

// Helpers para mutaciones seguras
const helpers = {
  addResources(player, delta) {
    player.recursos = Math.max(0, player.recursos + delta);
  },
  addMoral(player, delta) {
    player.moral = Math.max(0, Math.min(100, player.moral + delta));
  },
  addIntel(player, delta) {
    player.intel = Math.max(0, player.intel + delta);
  },
  addGlobalTension(delta) {
    gameState.global.tension = Math.max(0, Math.min(100, gameState.global.tension + delta));
  },
  addGlobalIntel(delta) {
    gameState.global.intel = Math.max(0, gameState.global.intel + delta);
  },
};

export function getState() {
  return gameState;
}

export function canAct(playerId) {
  const p = gameState.jugadores.find((j) => j.id === playerId);
  if (!p || !p.vivo) return { ok: false, reason: "Jugador inválido o eliminado" };
  if (gameState.fase !== "accion") return { ok: false, reason: "No estamos en fase de acción" };
  if (p.estado.penalizacionTurnos > 0) return { ok: false, reason: "Jugador penalizado este turno" };
  return { ok: true };
}

export function avanzarFase() {
  if (gameState.fase === "planificacion") {
    gameState.fase = "accion";
    pushLog("system", "Cambio de fase → acción");
    return;
  }

  if (gameState.fase === "accion") {
    gameState.fase = "resolucion";
    pushLog("system", "Cambio de fase → resolución");
    resolverTurno();
    return;
  }

  // resolucion → nuevo turno
  gameState.fase = "planificacion";
  gameState.turno += 1;

  // tick penalizaciones
  gameState.jugadores.forEach((j) => {
    if (j.estado.penalizacionTurnos > 0) j.estado.penalizacionTurnos -= 1;
    // se limpia protección si quieres que dure solo 1 turno:
    // j.estado.protegido = false;
  });

  // regeneración simple de recursos por turno
  gameState.jugadores.forEach((j) => {
    if (j.vivo) helpers.addResources(j, 2);
  });

  pushLog("system", `Nuevo turno #${gameState.turno}`);
}

export function ejecutarAccion({ playerId, actionId, targetId = null }) {
  const action = getActionById(actionId);
  if (!action) {
    pushLog("error", "Acción no existe", { actionId });
    return { ok: false, reason: "Acción inválida" };
  }

  const p = gameState.jugadores.find((j) => j.id === playerId);
  if (!p) return { ok: false, reason: "Jugador inválido" };

  const can = canAct(playerId);
  if (!can.ok) return can;

  if (p.recursos < action.costo) {
    return { ok: false, reason: "No tienes recursos suficientes" };
  }

  // pagar costo
  helpers.addResources(p, -action.costo);

  // aplicar efecto (simple, ajustable a tu enunciado)
  if (actionId === "RECON") {
    helpers.addIntel(p, 2);
    helpers.addGlobalIntel(1);
  }

  if (actionId === "FORTIFY") {
    p.estado.protegido = true;
  }

  if (actionId === "PROPAGANDA") {
    helpers.addMoral(p, +8);
    helpers.addGlobalTension(+5);
  }

  if (actionId === "STRIKE") {
    helpers.addGlobalTension(+10);
    if (targetId) {
      const t = gameState.jugadores.find((j) => j.id === targetId);
      if (t && t.vivo) helpers.addMoral(t, -12);
    }
  }

  pushLog("action", `Acción ejecutada: ${action.nombre}`, { playerId, actionId, targetId });

  return { ok: true };
}

export function queueEvent(eventObj) {
  if (!eventObj) return;
  gameState.eventosActivos.push(eventObj);
  pushLog("event", `Evento en cola: ${eventObj.nombre}`, { id: eventObj.id });
}

function resolverTurno() {
  // 1) genera un evento aleatorio (demo)
  const ev = pickRandomEvent(gameState);
  if (ev) queueEvent(ev);

  // 2) aplica eventos
  gameState.eventosActivos.forEach((e) => {
    e.apply(gameState, helpers);
    pushLog("event", `Evento resuelto: ${e.nombre}`, { id: e.id });
  });

  // 3) limpiar eventos
  gameState.eventosActivos = [];
}
