Component({
  options:{styleIsolation:'isolated'},
  properties: { label: String, unit: { type: String, value: 'pt' }, value: { type: Number, value: 12 }, min: { type: Number, value: 8 }, max: { type: Number, value: 20 }, step: { type: Number, value: 1 }, disabled: Boolean, presets: { type: Array, value: [] } },
  data: {sliderMin:8,sliderMax:20,sliderStep:1,sliderValue:12,scale:1},
  observers: {'value,min,max,step':function(value,min,max,step){const scale=step<1?100:1;this.setData({scale,sliderMin:Math.round(min*scale),sliderMax:Math.round(max*scale),sliderStep:Math.max(1,Math.round(step*scale)),sliderValue:Math.round(value*scale)});}},
  methods: {
    emit(value, final) {
      if (this.data.disabled) return;
      const step = this.data.step || 1;
      const next = Math.max(this.data.min, Math.min(this.data.max, Math.round(Number(value) / step) * step));
      if (!Number.isFinite(next)) return;
      this.triggerEvent(final ? 'change' : 'changing', { value: Math.round(next * 100) / 100 });
    },
    slide(e) { this.emit(e.detail.value / this.data.scale, false); },
    finish(e) { this.emit(e.detail.value / this.data.scale, true); },
    choose(e) { this.emit(e.currentTarget.dataset.value, true); },
    adjust(e) { this.emit(this.data.value + Number(e.currentTarget.dataset.direction) * this.data.step, true); }
  }
});
