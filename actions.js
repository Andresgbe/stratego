export const ACTIONS = {
  RECON: {
    id: "RECON",
    nombre: "Reconocimiento",
    costo: 1,
    descripcion: "Ganas intel y reduces incertidumbre del siguiente turno.",
  },
  FORTIFY: {
    id: "FORTIFY",
    nombre: "Fortificar",
    costo: 2,
    descripcion: "Te proteges ante un evento negativo en resolución.",
  },
  PROPAGANDA: {
    id: "PROPAGANDA",
    nombre: "Propaganda",
    costo: 2,
    descripcion: "Sube moral propia, pero aumenta tensión global.",
  },
  STRIKE: {
    id: "STRIKE",
    nombre: "Ataque",
    costo: 3,
    descripcion: "Impacto fuerte: sube tensión, baja moral de otro jugador.",
  },
};

export function listActions() {
  return Object.values(ACTIONS);
}

export function getActionById(actionId) {
  return ACTIONS[actionId] || null;
}
