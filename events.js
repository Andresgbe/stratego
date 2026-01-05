export function makeEvent({ id, nombre, descripcion, apply }) {
  return { id, nombre, descripcion, apply };
}

// Ejemplos de eventos (puedes cambiar nombres a los del enunciado)
export const EVENT_LIBRARY = {
  RUMOR: () =>
    makeEvent({
      id: "RUMOR",
      nombre: "Rumor en el frente",
      descripcion: "Baja moral a todos si la tensión está alta.",
      apply: (state, helpers) => {
        if (state.global.tension >= 50) {
          state.jugadores.forEach((j) => helpers.addMoral(j, -5));
        }
      },
    }),

  RAID: (targetPlayerId) =>
    makeEvent({
      id: "RAID",
      nombre: "Incursión",
      descripcion: "Afecta a un jugador a menos que esté fortificado.",
      apply: (state, helpers) => {
        const target = state.jugadores.find((j) => j.id === targetPlayerId);
        if (!target) return;

        if (target.estado.protegido) {
          // consume protección
          target.estado.protegido = false;
          return;
        }
        helpers.addMoral(target, -10);
        helpers.addResources(target, -1);
      },
    }),
};

// Generador simple de evento aleatorio
export function pickRandomEvent(state) {
  // regla simple: si tension alta, más chance de evento malo
  const tension = state.global.tension;

  if (tension >= 60) {
    // elegir un target random
    const alive = state.jugadores.filter((j) => j.vivo);
    const target = alive[Math.floor(Math.random() * alive.length)];
    return EVENT_LIBRARY.RAID(target.id);
  }

  if (tension >= 35) return EVENT_LIBRARY.RUMOR();

  return null;
}
