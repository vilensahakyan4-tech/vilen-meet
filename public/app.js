const $ = id => document.getElementById(id);

let createdMeeting = null;

function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 2600);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function switchTab(tab) {
  document.querySelectorAll('.tabs button').forEach(button => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  $('createForm').classList.toggle('hidden', tab !== 'create');
  $('joinForm').classList.toggle('hidden', tab !== 'join');
}

function cleanCode(value) {
  const text = String(value || '').trim();
  try {
    const url = new URL(text);
    return url.searchParams.get('code') || url.pathname.split('/').filter(Boolean).pop() || text;
  } catch {
    return text;
  }
}

function withName(url, name) {
  const next = new URL(url);
  if (name) next.searchParams.set('name', name);
  return next.toString();
}

async function createMeeting(event) {
  event?.preventDefault();
  const title = $('meetingTitle').value.trim() || 'VILEN Meet';
  const name = $('hostName').value.trim() || 'Вилен';
  try {
    const meeting = await api('/api/meetings', { title });
    createdMeeting = {
      ...meeting,
      joinURL: withName(meeting.joinURL, name)
    };
    $('createdTitle').textContent = title;
    $('createdLink').textContent = createdMeeting.joinURL;
    $('createdDialog').showModal();
  } catch (error) {
    toast(error.message.includes('Metered') ? 'Нужно настроить Metered ключи на сервере' : 'Не удалось создать встречу');
  }
}

async function joinMeeting(event) {
  event.preventDefault();
  const code = cleanCode($('joinCode').value);
  const name = $('guestName').value.trim() || 'Гость';
  if (!code) return toast('Введите код или ссылку встречи');
  try {
    const meeting = await api(`/api/meetings?code=${encodeURIComponent(code)}`);
    window.location.href = withName(meeting.joinURL, name);
  } catch {
    toast('Встреча не найдена');
  }
}

document.querySelectorAll('.tabs button').forEach(button => {
  button.onclick = () => switchTab(button.dataset.tab);
});

$('quickCreateBtn').onclick = createMeeting;
$('createForm').onsubmit = createMeeting;
$('joinForm').onsubmit = joinMeeting;
$('closeDialog').onclick = () => $('createdDialog').close();
$('copyLinkBtn').onclick = async () => {
  if (!createdMeeting) return;
  await navigator.clipboard.writeText(createdMeeting.joinURL);
  toast('Ссылка скопирована');
};
$('enterMeetingBtn').onclick = () => {
  if (createdMeeting) window.location.href = createdMeeting.joinURL;
};
