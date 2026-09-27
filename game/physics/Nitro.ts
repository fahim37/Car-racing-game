/** Five seconds of boost, followed by a short delay and gradual recharge. */
export class Nitro {
  enabled = false;
  charge = 1;
  active = false;
  private cooldown = 0;
  private exhausted = false;

  reset() {
    this.charge = 1;
    this.active = false;
    this.cooldown = 0;
    this.exhausted = false;
  }

  step(dt: number, requested: boolean, eligible: boolean) {
    if (!requested && this.charge >= 0.15) this.exhausted = false;
    this.active = this.enabled && requested && eligible && !this.exhausted && this.charge > 0;
    if (this.active) {
      this.charge = Math.max(0, this.charge - dt / 5);
      this.cooldown = 2;
      if (this.charge === 0) this.exhausted = true;
    } else {
      this.cooldown = Math.max(0, this.cooldown - dt);
      if (this.cooldown === 0) this.charge = Math.min(1, this.charge + dt / 14);
    }
    return this.active;
  }
}
