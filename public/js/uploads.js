// Image uploads straight from the browser to Cloudinary (signed by our server), plus a lightbox.

import { api, esc, icon, openModal } from './core.js';

export function pickImages({ multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}

// Phone photos are often 4–8 MB; scale large ones down before uploading over mobile data.
async function shrink(file, maxSide = 2000, quality = 0.85) {
  if (file.size < 1.2 * 1024 * 1024 || !/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

function uploadOne(file, sig, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    form.append('api_key', sig.api_key);
    form.append('timestamp', sig.timestamp);
    form.append('signature', sig.signature);
    form.append('folder', sig.folder);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${sig.cloud_name}/image/upload`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.secure_url) {
        resolve({ url: data.secure_url, public_id: data.public_id, width: data.width, height: data.height });
      } else {
        reject(new Error('تعذّر رفع إحدى الصور، يُرجى المحاولة مرة أخرى'));
      }
    };
    xhr.onerror = () => reject(new Error('تعذّر الاتصال بخدمة رفع الصور'));
    xhr.send(form);
  });
}

// signParams: { purpose: 'task', task_id } or { purpose: 'report' }. onProgress(0..1) covers the whole batch.
export async function uploadImages(files, signParams, onProgress = () => {}) {
  if (files.length > 10) throw new Error('يمكن رفع 10 صور كحد أقصى في المرة الواحدة');
  const sig = await api('POST', '/api/uploads/sign', signParams);
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const file = await shrink(files[i]);
    results.push(await uploadOne(file, sig, (p) => onProgress((i + p) / files.length)));
  }
  onProgress(1);
  return results;
}

// Cloudinary delivers resized copies when the transformation is placed after "/upload/".
export function thumb(url, size = 320) {
  return String(url).replace('/image/upload/', `/image/upload/c_fill,w_${size},h_${size},q_auto,f_auto/`);
}

export function gallery(images, { deletable = false } = {}) {
  if (!images.length) return '';
  return `<div class="gallery">${images.map((img, i) => `<figure class="shot" style="--i:${Math.min(i, 12)}">
    <button type="button" class="shot-open" data-full="${esc(img.url)}" data-caption="${esc(img.caption || '')}" aria-label="عرض الصورة">
      <img src="${esc(thumb(img.url))}" alt="${esc(img.caption || 'صورة مرفقة')}" loading="lazy"></button>
    ${img.caption ? `<figcaption>${esc(img.caption)}</figcaption>` : ''}
    ${deletable && img.deletable ? `<button type="button" class="shot-del" data-del-img="${img.id}" aria-label="حذف الصورة">${icon('trash')}</button>` : ''}
  </figure>`).join('')}</div>`;
}

export function bindGallery(root) {
  root.querySelectorAll('[data-full]').forEach((b) => b.addEventListener('click', () => openModal({
    title: b.dataset.caption || 'صورة مرفقة',
    wide: true,
    className: 'lightbox',
    body: `<img src="${esc(b.dataset.full)}" alt="" style="width:100%;border-radius:14px">
      <div class="modal-actions"><a class="btn ghost" href="${esc(b.dataset.full)}" target="_blank" rel="noopener">${icon('download')}فتح بالحجم الكامل</a></div>`,
  })));
}

export function progressBar(container) {
  container.innerHTML = '<div class="progress" style="margin-top:.6rem"><div style="width:0"></div></div>';
  const bar = container.querySelector('.progress > div');
  return (p) => { bar.style.width = `${Math.round(p * 100)}%`; };
}

// Preview → optional caption → upload with progress. Resolves after onDone(images, caption) succeeds.
export async function photoUploadModal({ signParams, withCaption = true, onDone }) {
  const files = await pickImages();
  if (!files.length) return;
  const previews = files.map((f) => URL.createObjectURL(f));
  const { form } = openModal({
    title: files.length === 1 ? 'رفع صورة' : `رفع ${files.length} صور`,
    body: `
      <div class="gallery" style="margin-bottom:1rem">${previews.map((src) => `<figure class="shot"><div class="shot-open" style="cursor:default"><img src="${src}" alt=""></div></figure>`).join('')}</div>
      ${withCaption ? '<div class="field"><label>وصف مختصر <span class="hint">(اختياري)</span></label><input name="caption" maxlength="300" placeholder="مثال: الشاشات المبدئية بعد المراجعة"></div>' : ''}
      <div id="up-progress"></div>`,
    submitLabel: 'رفع الصور',
    onSubmit: async (d, f) => {
      const setProgress = progressBar(f.querySelector('#up-progress'));
      const images = await uploadImages(files, signParams, setProgress);
      await onDone(images, (d.caption || '').trim());
      previews.forEach((u) => URL.revokeObjectURL(u));
    },
  });
  return form;
}
