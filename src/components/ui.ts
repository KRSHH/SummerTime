import { events } from '../core/events';

const speakerIcon = '<svg class="sound sound2" viewBox="0 0 17 13" aria-hidden="true"><path d="M10.189 0.228 6.13 3.332H4.168c-.512 0-.938.41-.938.938v4.384c0 .165.043.321.118.457L.816 10.907a1 1 0 1 0 1.157 1.631l4.153-2.946h.021l.026.02 5.756-4.082v-.054l3.694-2.62a1 1 0 0 0-1.157-1.631l-2.537 1.8V1.08c-.017-.904-1.041-1.399-1.74-.853Z" fill="#716C66"/></svg>';
const mutedIcon = '<svg class="sound sound2" viewBox="0 0 17 13" aria-hidden="true"><path d="M6.96.228 2.9 3.332H.938A.94.94 0 0 0 0 4.27v4.384c0 .511.41.938.938.938h1.979l4.042 3.104a1 1 0 0 0 1.74-.853V1.08C8.682.177 7.659-.318 6.96.228Z" fill="#716C66"/></svg>';
const infoIcon = '<svg class="info" viewBox="0 0 4 18" aria-hidden="true"><path d="M2 6a2 2 0 0 1 2 2v6.818a2 2 0 1 1-4 0V8a2 2 0 0 1 2-2ZM4 2a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" fill="#716C66"/></svg>';
const closeIcon = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="m1.5 1.5 15 15m0-15-15 15" stroke="#989389" stroke-width="2" stroke-linecap="round"/></svg>';

const infoContent = {
  about: {
    title: 'Summer Afternoon',
    paragraphs: [
      'This is a web experiment I made to practice some procedural 3D art. There are 5 secrets hidden across it. I hope you can find them!',
      'Thanks to Ana and Michael for their tips.',
      '<a href="https://vlucendo.com" rel="noreferrer" target="_blank" class="link2">Vicente</a>',
    ],
  },
  congrats: {
    title: 'You found all 5 secrets!',
    paragraphs: [
      "(I hope that didn't take too long)",
      "I don't have anything to give you other than my thanks for exploring this experiment, inspired by those calm summer days where life just passes by... ☀️",
    ],
  },
} as const;

type InfoName = keyof typeof infoContent;

export class UiController {
  readonly webglContainer: HTMLDivElement;
  private readonly loader: HTMLDivElement;
  private readonly nav: HTMLElement;
  private readonly secretModal: HTMLDivElement;
  private readonly infoModal: HTMLDivElement;
  private readonly infoPanel: HTMLElement;
  private readonly secretPanel: HTMLElement;
  private readonly colorSquare: HTMLDivElement;
  private readonly soundButton: HTMLButtonElement;
  private readonly count: HTMLDivElement;
  private easterEggs = 0;
  private totalEasterEggs = 0;
  private overlayOpen = false;
  private secretTimer = 0;

  constructor(root: HTMLElement) {
    this.webglContainer = document.createElement('div');
    this.webglContainer.id = 'webgl';
    root.append(this.webglContainer);

    this.loader = document.createElement('div');
    this.loader.id = 'loader';
    this.loader.innerHTML = '<h1>Summer<br>Afternoon</h1><div class="spinner"><svg viewBox="0 0 66 66" aria-hidden="true"><circle class="path" fill="none" stroke-width="7" stroke-linecap="round" cx="33" cy="33" r="29"/></svg></div>';
    root.append(this.loader);

    this.nav = document.createElement('nav');
    this.nav.innerHTML = '<button class="button" type="button" aria-label="toggle sound"></button><button class="button" type="button" aria-label="randomize character color"><div class="color-square"></div></button><button class="button" type="button" aria-label="about">' + infoIcon + '</button><div class="cnt">0/0</div>';
    root.append(this.nav);
    this.soundButton = this.nav.querySelectorAll('button')[0];
    const colorButton = this.nav.querySelectorAll('button')[1];
    const infoButton = this.nav.querySelectorAll('button')[2];
    this.colorSquare = colorButton.querySelector('.color-square') as HTMLDivElement;
    this.count = this.nav.querySelector('.cnt') as HTMLDivElement;
    this.soundButton.innerHTML = speakerIcon;
    this.soundButton.addEventListener('click', () => events.emit('webgl_audio_mute_toggle'));
    colorButton.addEventListener('click', () => events.emit('webgl_character_randomize_color'));
    infoButton.addEventListener('click', () => this.toggleOverlay('about'));

    this.secretModal = document.createElement('div');
    this.secretModal.id = 'modal';
    this.secretModal.innerHTML = '<div class="cnt"><div class="bg-dark"></div><div class="bg-light"></div><article></article><button class="button-close" type="button" aria-label="close">' + closeIcon + '</button></div>';
    root.append(this.secretModal);
    this.secretPanel = this.secretModal.querySelector('article') as HTMLElement;
    this.secretModal.querySelector('button')?.addEventListener('click', () => this.closeSecret());

    this.infoModal = document.createElement('div');
    this.infoModal.id = 'info';
    this.infoModal.innerHTML = '<div class="close-hit"></div><div class="cnt"><div class="bg-dark"></div><div class="bg-light"></div><article></article><button class="button-close" type="button" aria-label="close">' + closeIcon + '</button></div>';
    root.append(this.infoModal);
    this.infoPanel = this.infoModal.querySelector('article') as HTMLElement;
    this.infoModal.querySelector('.close-hit')?.addEventListener('click', () => this.closeOverlay());
    this.infoModal.querySelector('button')?.addEventListener('click', () => this.closeOverlay());
  }

  showUnsupported() {
    this.loader.remove();
    const unsupported = document.createElement('div');
    unsupported.id = 'unsupported';
    unsupported.textContent = 'Seems like WebGL2 is not supported by your browser 😰 Please update it to access the experience.';
    this.webglContainer.parentElement?.append(unsupported);
  }

  showExperience() {
    this.loader.remove();
    this.nav.classList.add('visible');
  }

  showSecret(message: string) {
    if (this.overlayOpen) this.closeOverlay();
    this.secretPanel.textContent = message;
    this.secretModal.classList.add('visible');
    this.count.textContent = this.easterEggs + '/' + this.totalEasterEggs;
    window.clearTimeout(this.secretTimer);
    this.secretTimer = window.setTimeout(() => this.closeSecret(), 10000);
    window.setTimeout(() => { this.easterEggs = Math.min(this.totalEasterEggs, this.easterEggs + 1); this.count.textContent = this.easterEggs + '/' + this.totalEasterEggs; }, 750);
  }

  incrementEasterEggs() {
    this.totalEasterEggs += 1;
    this.count.textContent = `${this.easterEggs}/${this.totalEasterEggs}`;
  }

  setMuted(muted: boolean) {
    this.soundButton.innerHTML = muted ? speakerIcon : mutedIcon;
  }

  setCharacterColor(color: string) {
    this.colorSquare.style.backgroundColor = color;
  }

  closeOverlay() {
    if (!this.overlayOpen) return;
    this.overlayOpen = false;
    this.infoModal.classList.remove('visible');
    this.nav.classList.add('visible');
    events.emit('webgl_overlay_animation', 0);
    events.emit('webgl_overlay_volume', 1);
    events.emit('webgl_character_controls_enable', true);
  }

  private toggleOverlay(name: InfoName) {
    if (this.overlayOpen) {
      this.closeOverlay();
      return;
    }
    this.overlayOpen = true;
    this.secretModal.classList.remove('visible');
    this.nav.classList.remove('visible');
    const content = infoContent[name];
    this.infoPanel.innerHTML = `<h1>${content.title}</h1>${content.paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('')}`;
    this.infoModal.classList.add('visible');
    events.emit('webgl_overlay_animation', 1);
    events.emit('webgl_overlay_volume', 0.4);
    events.emit('webgl_character_controls_enable', false);
  }

  private closeSecret() {
    if (!this.secretModal.classList.contains('visible')) return;
    this.secretModal.classList.remove('visible');
    if (this.easterEggs >= this.totalEasterEggs) this.toggleOverlay('congrats');
  }
}
