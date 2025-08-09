// frontend/script.js (enhanced)
function createProgressElem(form) {
  const container = document.createElement('div');
  container.className = 'progress-container';
  const progress = document.createElement('div');
  progress.className = 'progress w-full bg-gray-200 rounded';
  const bar = document.createElement('div');
  bar.className = 'bar bg-blue-600';
  bar.style.width = '0%';
  progress.appendChild(bar);
  const label = document.createElement('div');
  label.className = 'small-muted';
  label.textContent = '0%';
  container.appendChild(progress);
  container.appendChild(label);
  return { container, bar, label };
}

function downloadBlobResponse(res, defaultName) {
  return res.blob().then(blob => {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const disposition = res.headers.get('Content-Disposition') || '';
    let filename = defaultName;
    const match = disposition.match(/filename\*=UTF-8''(.+)|filename="?([^";]+)"?/);
    if (match) filename = decodeURIComponent(match[1] || match[2]);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  });
}

function postFormWithXhr(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.responseType = 'blob';
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        // create a Response from blob to reuse download logic
        const headers = new Headers();
        const disposition = xhr.getResponseHeader('Content-Disposition');
        if (disposition) headers.set('Content-Disposition', disposition);
        const res = new Response(xhr.response, { status: xhr.status, statusText: xhr.statusText, headers });
        resolve(res);
      } else {
        // try to parse server text error
        const reader = new FileReader();
        reader.onload = () => reject(new Error(reader.result || 'Server error'));
        reader.readAsText(xhr.response);
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.send(form);
  });
}

// helper for forms
async function handleFormSubmit(e, url, defaultName) {
  e.preventDefault();
  const form = new FormData(e.target);

  // create/attach progress bar
  let progressUI = null;
  const holder = e.target.querySelector('.progress-holder');
  if (holder) {
    progressUI = createProgressElem(form);
    holder.innerHTML = '';
    holder.appendChild(progressUI.container);
  }

  try {
    const res = await postFormWithXhr(url, form, (ratio) => {
      if (progressUI) {
        const pct = Math.round(ratio * 100);
        progressUI.bar.style.width = pct + '%';
        progressUI.label.textContent = pct + '%';
      }
    });
    await downloadBlobResponse(res, defaultName);
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    if (holder) holder.innerHTML = '';
  }
}

// wire up
const convertForm = document.getElementById('convertForm');
convertForm.onsubmit = (e) => handleFormSubmit(e, '/api/convert', 'converted_file');

const resizeForm = document.getElementById('resizeForm');
resizeForm.onsubmit = (e) => handleFormSubmit(e, '/api/resize', 'resized_image.jpg');

const compressForm = document.getElementById('compressForm');
compressForm.onsubmit = (e) => handleFormSubmit(e, '/api/compress', 'compressed.zip');