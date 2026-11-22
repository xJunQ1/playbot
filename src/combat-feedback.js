import { Vector3, MathUtils } from 'three';

// Stop multipliers use the light or heavy setting. Recoil is visual; push moves the grounded actor.
export const IMPACT = {
  light:        { stop: .60, shake: .053, recoil: .040, weight: .28, push: .045 },
  lightEnd:     { stop: .80, shake: .090, recoil: .064, weight: .48, push: .13 },
  heavy:        { stop: .75, shake: .132, recoil: .079, weight: .73, push: .16 },
  heavyEnd:     { stop: 1.0, shake: .190, recoil: .105, weight: .93, push: .28 },
  bossSlash:    { stop: .60, shake: .114, recoil: .075, weight: .62, push: .19 },
  bossSlam:     { stop: .88, shake: .208, recoil: .108, weight: .93, push: .38 },
  ultimateCut:  { stop: .20, shake: .041, recoil: .025, weight: .32, push: 0 },
  kick:         { stop: .40, shake: .101, recoil: .068, weight: .62, push: 0 },
  kickEnd:      { stop: .60, shake: .148, recoil: .086, weight: .83, push: 0 },
  finisher:     { stop: .75, shake: .225, recoil: .115, weight: 1, push: .23 },
  guard:        { stop: .60, shake: .051, recoil: 0, weight: .34, push: 0 },
  parry:        { stop: .88, shake: .135, recoil: 0, weight: .71, push: 0 },
  break:        { stop: .88, shake: .215, recoil: .113, weight: .96, push: .24 },
  meteor:       { stop: .75, shake: .330, recoil: .100, weight: 1, push: .43 },
};

export class ImpactCamera {
  constructor() {
    this.axis = new Vector3();
    this.offset = new Vector3();
    this.age = 0;
    this.duration = 0;
    this.strength = 0;
  }

  kick(direction, strength, lift) {
    if (this.age < .034 && this.duration > 0 && strength < this.strength) return;
    this.axis.copy(direction).setY(lift).normalize();
    this.age = 0;
    this.duration = .125 + strength * .63;
    this.strength = strength;
  }

  sample(dt, scale) {
    if (!this.duration) return this.offset.set(0,0,0);
    const t = MathUtils.clamp(this.age / this.duration, 0, 1);
    this.age += dt;
    if (t === 1) this.clear();
    // A sharp initial kick with a small return swing. Sampling by seconds
    // keeps its shape consistent when the game is frozen or running slowly.
    const envelope = (1-t)**2 * (Math.cos(t*10) - .16*Math.sin(t*10));
    return this.offset.copy(this.axis).multiplyScalar(this.strength * envelope * scale);
  }

  clear() {
    this.strength = this.duration = 0;
    this.offset.set(0,0,0);
  }
}
