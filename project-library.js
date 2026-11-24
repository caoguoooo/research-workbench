const $ = id => document.getElementById(id);
const endpoint = '/api/internal-projects';
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
let playerReady;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function button(text, className, action) {
  const element = node('button', className, text);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function image(url, description = '') {
  const element = node('img');
  element.src = url;
  element.alt = description;
  return element;
}

async function request(path, { method = 'GET', body } = {}) {
  const file = body instanceof File;
  const headers = { 'X-Workbench-Request': '1' };
  if (body) headers['Content-Type'] = file ? (body.type || 'application/octet-stream') : 'application/json';
  const response = await fetch(endpoint + path, { method, headers, body: file || !body ? body : JSON.stringify(body) });
  if (response.status === 401) window.location.replace('/login?expired=1');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '无法读取项目资料，请重试');
  return data;
}

function loadPlayer() {
  if (playerReady) return playerReady;
  playerReady = new Promise((resolve, reject) => {
    const load = (element, url) => new Promise((done, failed) => {
      element.onload = done;
      element.onerror = failed;
      if (element.tagName === 'LINK') element.href = url;
      else element.src = url;
      document.head.append(element);
    });
    const style = node('link');
    style.rel = 'stylesheet';
    const script = node('script');
    Promise.all([load(style, '/vendor/pannellum.css'), load(script, '/vendor/pannellum.js')])
      .then(() => {
        if (!window.pannellum?.viewer) throw new Error('全景播放器暂不可用');
        resolve(window.pannellum);
      }).catch(() => {
        style.remove();
        script.remove();
        playerReady = null;
        reject(new Error('全景播放器暂不可用'));
      });
  });
  return playerReady;
}

function today() {
  const date = new Date();
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(part => String(part).padStart(2, '0')).join('-');
}

export function initProjectLibrary() {
  const view = $('project-library-view');
  const list = $('project-library-list');
  const album = $('project-album');
  const groups = $('project-album-groups');
  const projectError = $('project-library-error');
  const nameDialog = $('project-name-dialog');
  const nameForm = $('project-name-form');
  const uploadDialog = $('project-upload-dialog');
  const uploadForm = $('project-upload-form');
  const photoDialog = $('project-photo-dialog');
  const photoForm = $('project-photo-form');
  const viewer = $('project-aerial-viewer');
  const stage = $('project-viewer-stage');
  const feedback = $('project-viewer-feedback');
  const thumbStrip = $('project-viewer-strip');
  const zoomIn = $('project-viewer-zoom-in');
  const zoomOut = $('project-viewer-zoom-out');
  let current = null;
  let pageRequest = 0;
  let nameTarget = null;
  let photoTarget = null;
  let pending = [];
  let uploading = false;
  let saving = false;
  let gallery = null;
  let selected = 0;
  let previewRequest = 0;
  let player = null;
  let zoom = 1;
  let displayedPhoto = null;

  function message(element, value = '') {
    element.textContent = value;
    element.hidden = !value;
  }

  function formError(form, error = '') {
    message(form.querySelector('[role=alert]'), error);
  }

  function disable(form, value) {
    for (const input of form.elements) input.disabled = value;
  }

  function openName(target) {
    nameTarget = target;
    nameForm.elements.name.value = target?.name || '';
    $('project-name-title').textContent = target ? (target.date ? '编辑相册名称' : '编辑项目') : '新建项目';
    formError(nameForm);
    nameDialog.showModal();
  }

  async function loadList() {
    const ticket = ++pageRequest;
    current = null;
    album.hidden = true;
    list.hidden = false;
    list.replaceChildren(node('p', 'archive-hint', '正在加载项目…'));
    message(projectError);
    try {
      const { items } = await request('');
      if (ticket !== pageRequest) return;
      list.replaceChildren();
      for (const item of items) {
        const card = button('', 'project-library-card', () => openProject(item.id));
        if (item.thumbnailUrl) {
          const thumb = image(item.thumbnailUrl);
          thumb.loading = 'lazy';
          card.append(thumb);
        } else card.append(node('span', 'project-card-placeholder', '航拍照片'));
        const details = node('span', 'project-card-caption');
        details.append(node('strong', '', item.name), node('small', '', `${item.photoCount} 张航拍`));
        card.append(details);
        list.append(card);
      }
      if (!items.length) list.append(node('p', 'archive-hint', '新建一个项目，就可以上传航拍照片。'));
    } catch (error) {
      if (ticket === pageRequest) {
        list.replaceChildren(button('重新加载', 'archive-secondary', loadList));
        message(projectError, error.message);
      }
    }
  }

  async function openProject(id) {
    const ticket = ++pageRequest;
    message(projectError);
    try {
      const { item } = await request('/' + id);
      if (ticket === pageRequest) renderAlbum(item);
    } catch (error) {
      if (ticket === pageRequest) message(projectError, error.message);
    }
  }

  function renderAlbum(item) {
    current = item;
    list.hidden = true;
    album.hidden = false;
    $('project-album-name').textContent = item.name;
    groups.replaceChildren();
    if (!item.groups.length) groups.append(node('p', 'archive-hint project-album-empty', '这里还没有航拍照片。'));
    for (const group of item.groups) {
      const section = node('section', 'project-album-group');
      const header = node('header', 'project-group-heading');
      const heading = node('div');
      heading.append(node('h3', '', group.title || group.date));
      const subtitle = [group.title ? group.date : '', `${group.photos.length} 张照片`].filter(Boolean).join(' · ');
      heading.append(node('p', '', subtitle));
      header.append(heading, button('编辑相册', 'archive-text-button', () => openName({ name: group.title || group.date, date: group.date })));
      const grid = node('div', 'project-photo-grid');
      group.photos.forEach((photo, index) => {
        const card = node('div', 'project-photo-card');
        const open = button('', 'project-photo-open', () => openGallery(group, index));
        const thumb = image(photo.thumbnailUrl);
        thumb.loading = 'lazy';
        open.append(thumb, node('span', 'project-photo-name', photo.name));
        if (photo.kind === 'panorama') open.append(node('span', 'project-photo-badge', '360°'));
        if (photo.id === group.coverId) open.append(node('span', 'project-cover-badge', '封面'));
        card.append(open, button('整理', 'archive-text-button', () => {
          photoTarget = photo;
          photoForm.elements.name.value = photo.name;
          formError(photoForm);
          photoDialog.showModal();
        }));
        grid.append(card);
      });
      section.append(header, grid);
      groups.append(section);
    }
  }

  async function edit(form, action) {
    if (saving) return;
    saving = true;
    disable(form, true);
    formError(form);
    try {
      const result = await action();
      if (!view.hidden) renderAlbum(result.item);
      form.closest('dialog').close();
    } catch (error) {
      formError(form, error.message);
    } finally {
      disable(form, false);
      saving = false;
    }
  }

  nameForm.addEventListener('submit', event => {
    event.preventDefault();
    const body = { [nameTarget?.date ? 'title' : 'name']: nameForm.elements.name.value };
    const url = nameTarget?.date ? `/${current.id}/groups/${nameTarget.date}` : nameTarget ? '/' + current.id : '';
    edit(nameForm, () => request(url, { method: nameTarget ? 'PATCH' : 'POST', body }));
  });
  photoForm.addEventListener('submit', event => {
    event.preventDefault();
    const body = { name: photoForm.elements.name.value };
    edit(photoForm, () => request(`/${current.id}/aerial/${photoTarget.id}`, { method: 'PATCH', body }));
  });
  photoForm.querySelectorAll('[data-aerial-action]').forEach(control => control.addEventListener('click', () => {
    const action = control.dataset.aerialAction;
    if (action === 'remove' && !window.confirm(`将「${photoTarget.name}」移出相册？`)) return;
    edit(photoForm, () => request(`/${current.id}/aerial/${photoTarget.id}`, { method: 'PATCH', body: { action } }));
  }));

  function renderUploads() {
    const container = $('project-upload-files');
    container.replaceChildren();
    for (const entry of pending) {
      const row = node('div', 'project-upload-row');
      const label = node('label', 'archive-field');
      label.append(node('span', '', entry.file.name));
      const type = node('select');
      type.append(new Option('普通照片', 'photo'), new Option('360° 全景', 'panorama'));
      type.value = entry.kind;
      type.addEventListener('change', () => { entry.kind = type.value; });
      label.append(type);
      row.append(label);
      if (entry.error) row.append(node('p', 'archive-form-error', entry.error));
      container.append(row);
    }
  }

  uploadForm.elements.files.addEventListener('change', () => {
    pending = Array.from(uploadForm.elements.files.files, file => ({ file, kind: 'photo', uploadId: crypto.randomUUID() }));
    formError(uploadForm);
    renderUploads();
  });

  uploadForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (uploading || !current) return;
    if (!pending.length) return formError(uploadForm, '请选择航拍照片');
    uploading = true;
    disable(uploadForm, true);
    formError(uploadForm);
    const id = current.id;
    const date = uploadForm.elements.date.value;
    const remaining = [];
    const progress = $('project-upload-progress');
    try {
      for (const [index, entry] of pending.entries()) {
        progress.textContent = `正在处理 ${index + 1} / ${pending.length} 张…`;
        try {
          if (entry.file.size > MAX_IMAGE_BYTES) throw new Error('单张照片不能超过 100 MB');
          const name = entry.file.name.replace(/\.(jpe?g|png|webp)$/i, '').slice(0, 120).trim() || '航拍照片';
          const query = new URLSearchParams({ name, date, kind: entry.kind, uploadId: entry.uploadId });
          const { item } = await request(`/${id}/aerial?${query}`, { method: 'POST', body: entry.file });
          if (current?.id === id && !view.hidden) renderAlbum(item);
        } catch (error) {
          entry.error = error.message;
          remaining.push(entry);
        }
      }
      const uploaded = pending.length - remaining.length;
      pending = remaining;
      renderUploads();
      if (!remaining.length) uploadDialog.close();
      else formError(uploadForm, `已保存 ${uploaded} 张。以下 ${remaining.length} 张请按提示处理后重试。`);
    } finally {
      uploading = false;
      progress.textContent = '';
      disable(uploadForm, false);
    }
  });

  function releasePreview() {
    previewRequest++;
    player?.destroy();
    player = null;
    displayedPhoto = null;
    stage.replaceChildren();
    stage.classList.remove('is-zoomed');
  }

  function zoomBy(direction) {
    if (player?.isLoaded()) {
      const fov = player.getHfov() * (direction > 0 ? 0.8 : 1.25);
      player.setHfov(Math.max(25, Math.min(110, fov)));
    } else if (displayedPhoto) {
      zoom = Math.max(1, Math.min(3, zoom + direction * 0.5));
      stage.classList.toggle('is-zoomed', zoom > 1);
      displayedPhoto.style.setProperty('--project-zoom', `${zoom * 100}%`);
      if (zoom === 1) stage.scrollTo(0, 0);
    }
  }

  function setZoomEnabled(enabled) {
    zoomIn.disabled = zoomOut.disabled = !enabled;
  }

  function showFlat(url, name, note = '') {
    stage.replaceChildren();
    const frame = node('div', 'project-flat-frame');
    const preview = image(url, name);
    displayedPhoto = preview;
    preview.onload = () => {
      if (preview !== displayedPhoto) return;
      message(feedback, note);
      setZoomEnabled(true);
    };
    preview.onerror = () => {
      if (preview !== displayedPhoto) return;
      message(feedback, '照片加载失败，请重新选择这张照片。');
    };
    frame.append(preview);
    stage.append(frame);
  }

  async function showPhoto(index) {
    if (!gallery?.photos[index]) return;
    selected = index;
    const photo = gallery.photos[index];
    releasePreview();
    const ticket = previewRequest;
    zoom = 1;
    stage.scrollTo(0, 0);
    setZoomEnabled(false);
    $('project-viewer-title').textContent = photo.name;
    $('project-viewer-meta').textContent = `${gallery.date} · ${photo.kind === 'panorama' ? '360° 全景' : '普通照片'} · ${index + 1} / ${gallery.photos.length}`;
    message(feedback, '正在加载照片…');
    $('project-viewer-prev').disabled = index === 0;
    $('project-viewer-next').disabled = index === gallery.photos.length - 1;
    for (const [position, thumb] of Array.from(thumbStrip.children).entries()) {
      thumb.setAttribute('aria-pressed', String(position === index));
    }
    const activeThumb = thumbStrip.children[index];
    if (activeThumb) {
      const strip = thumbStrip.getBoundingClientRect(), thumb = activeThumb.getBoundingClientRect();
      if (thumb.left < strip.left || thumb.right > strip.right) thumbStrip.scrollLeft += thumb.left - strip.left;
    }
    if (photo.kind !== 'panorama') {
      showFlat(photo.previewUrl, photo.name);
      return;
    }
    try {
      const pannellum = await loadPlayer();
      if (ticket !== previewRequest) return;
      const mount = node('div', 'project-pano');
      stage.append(mount);
      player = pannellum.viewer(mount, {
        type: 'equirectangular', panorama: photo.previewUrl, haov: 360, vaov: 180,
        autoLoad: true, showControls: false, showFullscreenCtrl: false, showZoomCtrl: false,
        mouseZoom: true, hfov: 95, minHfov: 25, maxHfov: 110
      });
      player.on('load', () => {
        if (ticket !== previewRequest) return;
        message(feedback);
        setZoomEnabled(true);
      });
      player.on('error', () => {
        if (ticket !== previewRequest) return;
        releasePreview();
        showFlat(photo.previewUrl, photo.name, '全景模式暂不可用，当前显示平面照片。');
      });
    } catch {
      if (ticket === previewRequest) showFlat(photo.previewUrl, photo.name, '全景模式暂不可用，当前显示平面照片。');
    }
  }

  function openGallery(group, index) {
    gallery = group;
    thumbStrip.replaceChildren();
    group.photos.forEach((photo, position) => {
      const thumb = button('', 'project-viewer-thumb', () => showPhoto(position));
      thumb.append(image(photo.thumbnailUrl));
      thumb.setAttribute('aria-label', `切换到 ${photo.name}`);
      thumb.firstChild.loading = 'lazy';
      thumbStrip.append(thumb);
    });
    viewer.showModal();
    showPhoto(index);
  }

  const full = $('project-viewer-full');
  full.addEventListener('click', () => {
    const enabled = viewer.classList.toggle('is-full');
    full.textContent = enabled ? '退出全屏' : '全屏';
    full.setAttribute('aria-pressed', String(enabled));
    requestAnimationFrame(() => player?.resize());
  });
  viewer.addEventListener('close', () => {
    releasePreview();
    gallery = null;
    thumbStrip.replaceChildren();
    viewer.classList.remove('is-full');
    full.textContent = '全屏';
    full.setAttribute('aria-pressed', 'false');
  });
  viewer.addEventListener('keydown', event => {
    if (event.target.closest('.project-pano')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      showPhoto(selected + (event.key === 'ArrowLeft' ? -1 : 1));
    }
  });
  $('project-viewer-prev').addEventListener('click', () => showPhoto(selected - 1));
  $('project-viewer-next').addEventListener('click', () => showPhoto(selected + 1));
  $('project-viewer-close').addEventListener('click', () => viewer.close());
  zoomIn.addEventListener('click', () => zoomBy(1));
  zoomOut.addEventListener('click', () => zoomBy(-1));
  $('project-album-back').addEventListener('click', loadList);
  $('project-library-add').addEventListener('click', () => openName(null));
  $('project-library-rename').addEventListener('click', () => openName(current));
  $('project-aerial-add').addEventListener('click', () => {
    uploadForm.reset();
    uploadForm.elements.date.value = today();
    pending = [];
    formError(uploadForm);
    renderUploads();
    uploadDialog.showModal();
  });
  for (const dialog of [nameDialog, uploadDialog, photoDialog]) {
    dialog.querySelector('[data-project-close]').addEventListener('click', () => { if (!uploading && !saving) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (uploading || saving) event.preventDefault(); });
  }

  return {
    show() {
      view.hidden = false;
      if (current) openProject(current.id);
      else loadList();
    },
    hide() {
      pageRequest++;
      view.hidden = true;
      if (viewer.open) viewer.close();
    }
  };
}
