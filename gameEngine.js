import {
  gameState,
  pushLog,
  STRATEGO_ARMY_CONFIG,
  makeDefaultStrategoInventory,
  resetStrategoState,
} from "./gameState.js";
import { getActionById } from "./actions.js";
import { pickRandomEvent } from "./events.js";

// =========================================================
// 0) Pub/Sub — la UI se actualiza desde gameState
// =========================================================
const _listeners = new Set();

export function subscribe(fn) {
  _listeners.add(fn);
  // dispara una vez inicial
  try {
    fn(gameState);
  } catch {
    // ignore
  }
  return () => _listeners.delete(fn);
}

function notify() {
  _listeners.forEach((fn) => {
    try {
      fn(gameState);
    } catch {
      // ignore
    }
  });
}

// =========================================================
// 1) Helpers para mutaciones seguras (motor de acciones)
// =========================================================
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
    gameState.global.tension = Math.max(
      0,
      Math.min(100, gameState.global.tension + delta)
    );
  },
  addGlobalIntel(delta) {
    gameState.global.intel = Math.max(
      0,
      Math.min(100, gameState.global.intel + delta)
    );
  },
};

export function getState() {
  return gameState;
}

export function setScreen(screen) {
  if (screen !== "lobby" && screen !== "warroom") return;
  gameState.screen = screen;
  notify();
}

export function canAct(playerId) {
  const p = gameState.jugadores.find((j) => j.id === playerId);
  if (!p || !p.vivo) return { ok: false, reason: "Jugador inválido o eliminado" };
  if (gameState.fase !== "accion") return { ok: false, reason: "No estamos en fase de acción" };
  if (p.estado.penalizacionTurnos > 0)
    return { ok: false, reason: "Jugador penalizado este turno" };
  return { ok: true };
}

export function avanzarFase() {
  if (gameState.fase === "planificacion") {
    gameState.fase = "accion";
    pushLog("system", "Cambio de fase → acción");
    notify();
    return;
  }

  if (gameState.fase === "accion") {
    gameState.fase = "resolucion";
    pushLog("system", "Cambio de fase → resolución");
    resolverTurno();
    notify();
    return;
  }

  // resolucion → nuevo turno
  gameState.fase = "planificacion";
  gameState.turno += 1;

  // tick penalizaciones
  gameState.jugadores.forEach((j) => {
    if (j.estado.penalizacionTurnos > 0) j.estado.penalizacionTurnos -= 1;
  });

  // regeneración simple de recursos por turno
  gameState.jugadores.forEach((j) => {
    if (j.vivo) helpers.addResources(j, 2);
  });

  pushLog("system", `Nuevo turno #${gameState.turno}`);
  notify();
}

export function ejecutarAccion({ playerId, actionId, targetId = null }) {
  const action = getActionById(actionId);
  if (!action) {
    pushLog("error", "Acción no existe", { actionId });
    notify();
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

  // aplicar efecto (demo)
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

  pushLog("action", `Acción ejecutada: ${action.nombre}`, {
    playerId,
    actionId,
    targetId,
  });

  notify();
  return { ok: true };
}

export function queueEvent(eventObj) {
  if (!eventObj) return;
  gameState.eventosActivos.push(eventObj);
  pushLog("event", `Evento en cola: ${eventObj.nombre}`, { id: eventObj.id });
  notify();
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

// =========================================================
// 2) Stratego — Etapa III (despliegue/board) con autoridad del engine
// =========================================================

function cellId(r, c) {
  return `cell-${r}-${c}`;
}

function parseCellId(id) {
  const m = /^cell-(\d+)-(\d+)$/.exec(id);
  if (!m) return null;
  return { r: Number(m[1]), c: Number(m[2]) };
}

function isWater(r, c) {
  return (r === 4 || r === 5) && ((c === 2 || c === 3) || (c === 6 || c === 7));
}

function isDeployCell(playerId, r, c) {
  if (playerId === 1) return r >= 0 && r <= 3;
  if (playerId === 2) return r >= 6 && r <= 9;
  return false;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function strategoGetPhase() {
  return gameState.stratego.phase;
}

export function strategoSetPhase(phase) {
  const allowed = ["DEPLOYMENT", "HANDSHAKE", "BATTLE", "GAME_OVER"];
  if (!allowed.includes(phase)) return;
  gameState.stratego.phase = phase;
  if (phase !== "BATTLE") gameState.stratego.ui.selectedCell = null;
  notify();
}

export function strategoCountInventoryLeft(playerId = 1) {
  const inv = gameState.stratego.inventory[playerId] || {};
  return Object.values(inv).reduce((a, b) => a + (b || 0), 0);
}

export function strategoClearDeployment(playerId = 1) {
  // limpia piezas del jugador en tablero
  const board = gameState.stratego.board;
  for (const cid of Object.keys(board)) {
    if (board[cid]?.ownerId === playerId) delete board[cid];
  }

  // reinicia inventario del jugador
  gameState.stratego.inventory[playerId] = makeDefaultStrategoInventory();
  gameState.stratego.ready[playerId] = false;

  // si estabas en handshake, vuelve a deployment
  // IMPORTANTE: no fuerces cambio de fase.
  // "Limpiar" solo debe tener sentido en DEPLOYMENT.
  // En HANDSHAKE/BATTLE no debe tumbar la fase del juego.
  if (gameState.stratego.phase !== "DEPLOYMENT") {
    notify();
    return;
  }


  notify();
}

export function strategoPlaceFromInventory({ playerId = 1, rank, targetCellId }) {
  if (gameState.stratego.phase !== "DEPLOYMENT") {
    return { ok: false, reason: "No estás en fase de despliegue" };
  }

  const pos = parseCellId(targetCellId);
  if (!pos) return { ok: false, reason: "Celda inválida" };
  if (isWater(pos.r, pos.c)) return { ok: false, reason: "No puedes colocar en el lago" };
  if (!isDeployCell(playerId, pos.r, pos.c))
    return { ok: false, reason: "Fuera de tu zona de despliegue" };

  if (gameState.stratego.board[targetCellId])
    return { ok: false, reason: "Celda ocupada" };

  const inv = gameState.stratego.inventory[playerId] || {};
  const left = inv[rank] || 0;
  if (left <= 0) return { ok: false, reason: "No quedan unidades de ese tipo" };

  inv[rank] = left - 1;
  gameState.stratego.inventory[playerId] = inv;
  gameState.stratego.board[targetCellId] = { ownerId: playerId, rank };

  notify();
  return { ok: true };
}

export function strategoMoveOrSwapDeployment({ playerId = 1, fromCellId, toCellId }) {
  if (gameState.stratego.phase !== "DEPLOYMENT") {
    return { ok: false, reason: "No estás en fase de despliegue" };
  }

  const from = parseCellId(fromCellId);
  const to = parseCellId(toCellId);
  if (!from || !to) return { ok: false, reason: "Celda inválida" };
  if (isWater(to.r, to.c)) return { ok: false, reason: "No puedes mover al lago" };

  // solo dentro de tu zona
  if (!isDeployCell(playerId, from.r, from.c))
    return { ok: false, reason: "Origen fuera de tu zona" };
  if (!isDeployCell(playerId, to.r, to.c))
    return { ok: false, reason: "Destino fuera de tu zona" };

  const board = gameState.stratego.board;
  const moving = board[fromCellId];
  if (!moving) return { ok: false, reason: "No hay pieza en el origen" };
  if (moving.ownerId !== playerId)
    return { ok: false, reason: "Solo puedes mover tus piezas" };

  const target = board[toCellId];

  // mover
  if (!target) {
    delete board[fromCellId];
    board[toCellId] = moving;
    notify();
    return { ok: true };
  }

  // swap (solo con pieza propia)
  if (target.ownerId !== playerId)
    return { ok: false, reason: "No puedes intercambiar con pieza enemiga" };

  board[toCellId] = moving;
  board[fromCellId] = target;

  notify();
  return { ok: true };
}

export function strategoRandomizeDeployment(playerId = 1) {
  if (gameState.stratego.phase !== "DEPLOYMENT") return { ok: false, reason: "No estás en despliegue" };

  // limpia piezas propias + inventario full
  strategoClearDeployment(playerId);

  // genera celdas válidas
  const cells = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (isWater(r, c)) continue;
      if (isDeployCell(playerId, r, c)) cells.push(cellId(r, c));
    }
  }

  const pool = shuffle(cells);
  const inv = gameState.stratego.inventory[playerId];

  for (const def of STRATEGO_ARMY_CONFIG) {
    while ((inv[def.rank] || 0) > 0) {
      const cid = pool.pop();
      if (!cid) break;
      inv[def.rank] = (inv[def.rank] || 0) - 1;
      gameState.stratego.board[cid] = { ownerId: playerId, rank: def.rank };
    }
  }

  notify();
  return { ok: true };
}

export function strategoExportDeployment(playerId = 1) {
  const out = {};
  for (const [cid, piece] of Object.entries(gameState.stratego.board)) {
    if (piece?.ownerId === playerId) out[cid] = { rank: piece.rank };
  }
  return out;
}

export function strategoImportDeployment(playerId = 1, data = {}) {
  if (gameState.stratego.phase !== "DEPLOYMENT") {
    return { ok: false, reason: "Solo puedes cargar en despliegue" };
  }

  const board = gameState.stratego.board;
  for (const cid of Object.keys(board)) {
    if (board[cid]?.ownerId === playerId) delete board[cid];
  }

  gameState.stratego.inventory[playerId] = makeDefaultStrategoInventory();
  gameState.stratego.ready[playerId] = false;

  for (const [cid, obj] of Object.entries(data || {})) {
    const rank = obj?.rank;
    if (!rank) continue;

    const pos = parseCellId(cid);
    if (!pos) continue;
    if (isWater(pos.r, pos.c)) continue;
    if (!isDeployCell(playerId, pos.r, pos.c)) continue;
    if (board[cid]) continue;

    const inv = gameState.stratego.inventory[playerId];
    if ((inv[rank] || 0) <= 0) continue;

    inv[rank] -= 1;
    board[cid] = { ownerId: playerId, rank };
  }

  notify();
  return { ok: true };
}

let _handshakeTimer = null;

export function strategoSetReady(playerId = 1, { autoEnemy = true } = {}) {
  if (gameState.stratego.phase !== 'DEPLOYMENT') {
    return { ok: false, reason: 'Solo puedes dar listo en despliegue' };
  }

  const left = strategoCountInventoryLeft(playerId);
  if (left > 0) {
    return { ok: false, reason: `Aún tienes ${left} tropas sin asignar` };
  }

  gameState.stratego.ready[playerId] = true;
  gameState.stratego.pveAuto = Boolean(autoEnemy);

  // PvE demo: auto despliega enemigo
  if (autoEnemy) {
    const enemyId = playerId === 1 ? 2 : 1;

    if (!gameState.stratego.ready[enemyId]) {
      if (!gameState.stratego.inventory[enemyId]) {
        gameState.stratego.inventory[enemyId] = makeDefaultStrategoInventory();
      }

      const prevPhase = gameState.stratego.phase;
      gameState.stratego.phase = 'DEPLOYMENT';
      strategoRandomizeDeployment(enemyId);
      gameState.stratego.phase = prevPhase;

      gameState.stratego.ready[enemyId] = true;
    }
  }

  // ✅ Solo iniciamos handshake cuando ambos están listos
  const allReady = Object.values(gameState.stratego.ready || {}).every(Boolean);

  if (!allReady) {
    pushLog('system', 'Listo recibido. Esperando al rival...', { playerId });
    notify();
    return { ok: true };
  }

  gameState.stratego.phase = 'HANDSHAKE';
  pushLog('system', 'Formaciones confirmadas: handshake iniciado', {
    ready: gameState.stratego.ready,
  });

  if (_handshakeTimer) {
    clearTimeout(_handshakeTimer);
    _handshakeTimer = null;
  }

  _handshakeTimer = setTimeout(() => {
    if (gameState.stratego.phase !== 'HANDSHAKE') return;

    gameState.stratego.phase = 'BATTLE';

    // En Stratego clásico inicia el equipo del retador (aquí: player 1)
    gameState.stratego.turnOwnerId = 1;
    gameState.stratego.lastCombat = null;
    gameState.stratego.ui.selectedCell = null;

    pushLog('system', '¡Batalla iniciada!', { turnOwnerId: gameState.stratego.turnOwnerId });
    notify();
    maybeAutoEnemyTurn();
  }, 3000);

  notify();
  return { ok: true };
}

// =========================================================
// 3) Stratego — Etapa IV (BATTLE): movimiento + combate
// =========================================================

function getRankValue(rank) {
  // Valores base para comparar (solo numéricos)
  const n = Number(rank);
  return Number.isFinite(n) ? n : 0;
}

function isMovableRank(rank) {
  return rank !== "B" && rank !== "F";
}

function isOrthogonalStep(a, b) {
  const A = parseCellId(a);
  const B = parseCellId(b);
  if (!A || !B) return false;
  const dr = Math.abs(A.r - B.r);
  const dc = Math.abs(A.c - B.c);
  return (dr + dc) === 1;
}

function isClearScoutPath(fromId, toId, board) {
  const A = parseCellId(fromId);
  const B = parseCellId(toId);
  if (!A || !B) return false;

  // Debe ser línea recta
  const sameRow = A.r === B.r;
  const sameCol = A.c === B.c;
  if (!sameRow && !sameCol) return false;

  const dr = sameRow ? 0 : (B.r > A.r ? 1 : -1);
  const dc = sameCol ? 0 : (B.c > A.c ? 1 : -1);

  let r = A.r + dr;
  let c = A.c + dc;

  // Recorremos hasta antes del destino (el destino puede tener enemigo)
  while (!(r === B.r && c === B.c)) {
    if (isWater(r, c)) return false;
    const cid = cellId(r, c);
    if (board[cid]) return false; // bloqueado por pieza
    r += dr;
    c += dc;
  }

  // El destino no puede ser agua
  if (isWater(B.r, B.c)) return false;

  return true;
}

function resolveCombat(attacker, defender) {
  // retorna { outcome, attackerDies, defenderDies, special }
  // outcome: "ATTACKER_WINS" | "DEFENDER_WINS" | "TIE"
  const a = attacker.rank;
  const d = defender.rank;

  // Captura bandera
  if (d === "F") {
    return { outcome: "ATTACKER_WINS", attackerDies: false, defenderDies: true, special: "FLAG_CAPTURED" };
  }

  // Bombas: por regla Etapa IV (demo): "4" desactiva bombas
  if (d === "B") {
    if (a === "4") {
      return { outcome: "ATTACKER_WINS", attackerDies: false, defenderDies: true, special: "BOMB_DEFUSED" };
    }
    return { outcome: "DEFENDER_WINS", attackerDies: true, defenderDies: false, special: "BOMB_EXPLODES" };
  }

  // Espía vs Mariscal SOLO si espía ataca
  if (a === "S" && d === "10") {
    return { outcome: "ATTACKER_WINS", attackerDies: false, defenderDies: true, special: "SPY_ASSASSINATES" };
  }

  // Espía normalmente es el más débil
  if (a === "S" && d !== "10") {
    return { outcome: "DEFENDER_WINS", attackerDies: true, defenderDies: false, special: "SPY_LOSES" };
  }

  const av = getRankValue(a);
  const dv = getRankValue(d);

  if (av > dv) return { outcome: "ATTACKER_WINS", attackerDies: false, defenderDies: true, special: null };
  if (av < dv) return { outcome: "DEFENDER_WINS", attackerDies: true, defenderDies: false, special: null };
  return { outcome: "TIE", attackerDies: true, defenderDies: true, special: "EQUAL_RANKS" };
}

function hasAnyLegalMove(playerId) {
  const board = gameState.stratego.board;
  for (const [fromId, piece] of Object.entries(board)) {
    if (!piece || piece.ownerId !== playerId) continue;
    if (!isMovableRank(piece.rank)) continue;

    // Generar movimientos rápidos (sin lista completa)
    // 1 paso
    const A = parseCellId(fromId);
    if (!A) continue;

    const candidates = [
      cellId(A.r - 1, A.c),
      cellId(A.r + 1, A.c),
      cellId(A.r, A.c - 1),
      cellId(A.r, A.c + 1),
    ];

    // Explorador: también intentamos rayos hasta borde
    if (piece.rank === "2") {
      // arriba
      for (let r = A.r - 1; r >= 0; r--) candidates.push(cellId(r, A.c));
      // abajo
      for (let r = A.r + 1; r < 10; r++) candidates.push(cellId(r, A.c));
      // izq
      for (let c = A.c - 1; c >= 0; c--) candidates.push(cellId(A.r, c));
      // der
      for (let c = A.c + 1; c < 10; c++) candidates.push(cellId(A.r, c));
    }

    for (const toId of candidates) {
      const to = parseCellId(toId);
      if (!to) continue;
      if (to.r < 0 || to.r >= 10 || to.c < 0 || to.c >= 10) continue;
      if (isWater(to.r, to.c)) continue;

      const target = board[toId];
      if (target && target.ownerId === playerId) continue;

      if (piece.rank === "2") {
        if (!isClearScoutPath(fromId, toId, board)) continue;
        return true;
      } else {
        if (!isOrthogonalStep(fromId, toId)) continue;
        return true;
      }
    }
  }
  return false;
}

function listLegalMovesForPlayer(playerId) {
  const board = gameState.stratego.board;
  const moves = [];

  for (const [fromId, piece] of Object.entries(board)) {
    if (!piece || piece.ownerId !== playerId) continue;
    if (!isMovableRank(piece.rank)) continue;

    const A = parseCellId(fromId);
    if (!A) continue;

    const pushIfOk = (toId) => {
      const to = parseCellId(toId);
      if (!to) return;
      if (to.r < 0 || to.r >= 10 || to.c < 0 || to.c >= 10) return;
      if (isWater(to.r, to.c)) return;

      const target = board[toId];
      if (target && target.ownerId === playerId) return;

      // Validación por tipo de pieza
      if (piece.rank === "2") {
        if (!isClearScoutPath(fromId, toId, board)) return;
      } else {
        if (!isOrthogonalStep(fromId, toId)) return;
      }

      moves.push({ fromCellId: fromId, toCellId: toId });
    };

    // Movimientos
    if (piece.rank === "2") {
      // explorador: rayos
      for (let r = A.r - 1; r >= 0; r--) pushIfOk(cellId(r, A.c));
      for (let r = A.r + 1; r < 10; r++) pushIfOk(cellId(r, A.c));
      for (let c = A.c - 1; c >= 0; c--) pushIfOk(cellId(A.r, c));
      for (let c = A.c + 1; c < 10; c++) pushIfOk(cellId(A.r, c));
    } else {
      // 1 paso ortogonal
      pushIfOk(cellId(A.r - 1, A.c));
      pushIfOk(cellId(A.r + 1, A.c));
      pushIfOk(cellId(A.r, A.c - 1));
      pushIfOk(cellId(A.r, A.c + 1));
    }
  }

  return moves;
}

function maybeAutoEnemyTurn() {
  if (gameState.stratego.phase !== "BATTLE") return;
  if (!gameState.stratego.pveAuto) return;

  const enemyId = 2; // demo: P1 humano, P2 autómata
  if (gameState.stratego.turnOwnerId !== enemyId) return;
  if (gameState.stratego.winnerPlayerId) return;

  const moves = listLegalMovesForPlayer(enemyId);
  if (moves.length === 0) {
    // si no puede mover, gana el rival
    gameState.stratego.winnerPlayerId = 1;
    gameState.stratego.phase = "GAME_OVER";
    pushLog("system", "Victoria: el autómata no tiene movimientos", { winnerPlayerId: 1 });
    notify();
    return;
  }

  const pick = moves[Math.floor(Math.random() * moves.length)];

  // Pequeño delay para que se “sienta” como turno enemigo
  setTimeout(() => {
    // Ojo: llamamos a strategoMove, que ya maneja combate + cambio de turno.
    strategoMove({ playerId: enemyId, ...pick });
  }, 350);
}

export function strategoGetLegalTargets(playerId = 1, fromCellId) {
  if (gameState.stratego.phase !== "BATTLE") return [];
  if (gameState.stratego.winnerPlayerId) return [];
  if (gameState.stratego.turnOwnerId !== playerId) return [];

  const board = gameState.stratego.board || {};
  const piece = board[fromCellId];
  if (!piece) return [];
  if (piece.ownerId !== playerId) return [];
  if (!isMovableRank(piece.rank)) return [];

  const A = parseCellId(fromCellId);
  if (!A) return [];

  const targets = [];

  const pushIfOk = (toId) => {
    const to = parseCellId(toId);
    if (!to) return;
    if (to.r < 0 || to.r >= 10 || to.c < 0 || to.c >= 10) return;
    if (isWater(to.r, to.c)) return;

    const target = board[toId];
    if (target && target.ownerId === playerId) return;

    // Validación por tipo de pieza
    if (piece.rank === "2") {
      if (!isClearScoutPath(fromCellId, toId, board)) return;
    } else {
      if (!isOrthogonalStep(fromCellId, toId)) return;
    }

    targets.push(toId);
  };

  if (piece.rank === "2") {
    // Explorador: rayos
    for (let r = A.r - 1; r >= 0; r--) pushIfOk(cellId(r, A.c));
    for (let r = A.r + 1; r < 10; r++) pushIfOk(cellId(r, A.c));
    for (let c = A.c - 1; c >= 0; c--) pushIfOk(cellId(A.r, c));
    for (let c = A.c + 1; c < 10; c++) pushIfOk(cellId(A.r, c));
  } else {
    // 1 paso ortogonal
    pushIfOk(cellId(A.r - 1, A.c));
    pushIfOk(cellId(A.r + 1, A.c));
    pushIfOk(cellId(A.r, A.c - 1));
    pushIfOk(cellId(A.r, A.c + 1));
  }

  return targets;
}

export function strategoSelectCell(playerId = 1, cellIdToSelect = null) {
  if (gameState.stratego.phase !== "BATTLE") return { ok: false, reason: "No estás en combate" };
  if (gameState.stratego.winnerPlayerId) return { ok: false, reason: "Partida terminada" };
  if (gameState.stratego.turnOwnerId !== playerId) return { ok: false, reason: "No es tu turno" };

  if (!cellIdToSelect) {
    gameState.stratego.ui.selectedCell = null;
    notify();
    return { ok: true };
  }

  const piece = gameState.stratego.board[cellIdToSelect];
  if (!piece) return { ok: false, reason: "No hay pieza ahí" };
  if (piece.ownerId !== playerId) return { ok: false, reason: "Solo puedes seleccionar tus piezas" };
  if (!isMovableRank(piece.rank)) return { ok: false, reason: "Esa pieza no se puede mover" };

  gameState.stratego.ui.selectedCell = cellIdToSelect;
  notify();
  return { ok: true };
}

export function strategoMove({ playerId = 1, fromCellId, toCellId }) {
  if (gameState.stratego.phase !== "BATTLE") return { ok: false, reason: "No estás en combate" };
  if (gameState.stratego.winnerPlayerId) return { ok: false, reason: "Partida terminada" };
  if (gameState.stratego.turnOwnerId !== playerId) return { ok: false, reason: "No es tu turno" };

  const from = parseCellId(fromCellId);
  const to = parseCellId(toCellId);
  if (!from || !to) return { ok: false, reason: "Celda inválida" };
  if (to.r < 0 || to.r >= 10 || to.c < 0 || to.c >= 10) return { ok: false, reason: "Fuera del tablero" };
  if (isWater(to.r, to.c)) return { ok: false, reason: "No puedes ir al lago" };

  const board = gameState.stratego.board;
  const moving = board[fromCellId];
  if (!moving) return { ok: false, reason: "No hay pieza en el origen" };
  if (moving.ownerId !== playerId) return { ok: false, reason: "Solo puedes mover tus piezas" };
  if (!isMovableRank(moving.rank)) return { ok: false, reason: "Esa pieza no se puede mover" };

  const target = board[toCellId];
  if (target && target.ownerId === playerId) return { ok: false, reason: "Destino ocupado por tu pieza" };

  // Validación de movimiento
  if (moving.rank === "2") {
    if (!isClearScoutPath(fromCellId, toCellId, board))
      return { ok: false, reason: "Movimiento inválido (Explorador requiere camino libre en línea recta)" };
  } else {
    if (!isOrthogonalStep(fromCellId, toCellId))
      return { ok: false, reason: "Movimiento inválido (solo 1 casilla ortogonal)" };
  }

  // Movimiento simple
  if (!target) {
    delete board[fromCellId];
    board[toCellId] = moving;

    gameState.stratego.ui.selectedCell = null;

    // Cambiar turno
    const next = gameState.jugadores.find((j) => j.id !== playerId)?.id ?? (playerId === 1 ? 2 : 1);
    gameState.stratego.turnOwnerId = next;
    gameState.turno += 1;
    maybeAutoEnemyTurn();

    // Victoria por no-moves
    if (!hasAnyLegalMove(next)) {
      gameState.stratego.winnerPlayerId = playerId;
      gameState.stratego.phase = "GAME_OVER";
      pushLog("system", "Victoria: el rival no tiene movimientos", { winnerPlayerId: playerId });
    }

    notify();
    return { ok: true };
  }

  // Combate
  const result = resolveCombat(moving, target);

  gameState.stratego.lastCombat = {
    fromCellId,
    toCellId,
    attacker: { ownerId: moving.ownerId, rank: moving.rank },
    defender: { ownerId: target.ownerId, rank: target.rank },
    outcome: result.outcome,
    special: result.special,
  };

  pushLog("action", "Combate", gameState.stratego.lastCombat);

  // Aplicar outcome
  if (result.outcome === "ATTACKER_WINS") {
    delete board[fromCellId];
    delete board[toCellId];
    board[toCellId] = moving; // ocupa la celda
  } else if (result.outcome === "DEFENDER_WINS") {
    delete board[fromCellId]; // atacante muere
    // defensor queda
  } else {
    // tie
    delete board[fromCellId];
    delete board[toCellId];
  }

  // Flag capturada
  if (result.special === "FLAG_CAPTURED") {
    gameState.stratego.winnerPlayerId = playerId;
    gameState.stratego.phase = "GAME_OVER";
    pushLog("system", "¡Bandera capturada! Fin de la partida.", { winnerPlayerId: playerId });
    gameState.stratego.ui.selectedCell = null;
    notify();
    return { ok: true };
  }

  gameState.stratego.ui.selectedCell = null;

  // Cambiar turno
  const next = gameState.jugadores.find((j) => j.id !== playerId)?.id ?? (playerId === 1 ? 2 : 1);
    gameState.stratego.turnOwnerId = next;
    gameState.turno += 1;
    maybeAutoEnemyTurn();

  // Victoria por no-moves
  if (!hasAnyLegalMove(next)) {
    gameState.stratego.winnerPlayerId = playerId;
    gameState.stratego.phase = "GAME_OVER";
    pushLog("system", "Victoria: el rival no tiene movimientos", { winnerPlayerId: playerId });
  }

  notify();
  return { ok: true };
}

export function strategoResetAll({ playerIds = [1, 2] } = {}) {
  resetStrategoState({ playerIds });
  notify();
}
