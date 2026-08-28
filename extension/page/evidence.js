const { webwingEvidencePreview: file } = await chrome.storage.session.get('webwingEvidencePreview');
const proof = document.getElementById('proof');
const empty = document.getElementById('empty');
const download = document.getElementById('download');

if (file?.base64 && file?.type === 'image/png') {
  const src = `data:${file.type};base64,${file.base64}`;
  proof.src = src;
  proof.hidden = false;
  download.href = src;
  download.download = file.name || 'webwing-yagun-evidence.png';
  download.hidden = false;
} else {
  empty.hidden = false;
}

document.getElementById('close').addEventListener('click', () => window.close());
