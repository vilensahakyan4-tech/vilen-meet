const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const room = params.get('room');
const code = params.get('code') || 'meeting';
const name = params.get('name') || '';

function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 2600);
}

function safeRoom(value) {
  return /^https:\/\/[a-z0-9-]+\.metered\.live\/[a-z0-9-]+$/i.test(value || '');
}

function inviteURL() {
  const url = new URL(location.href);
  url.searchParams.delete('name');
  return url.toString();
}

$('meetingCode').textContent = code;
$('copyInviteBtn').onclick = async () => {
  await navigator.clipboard.writeText(inviteURL());
  toast('Ссылка скопирована');
};

if (!safeRoom(room)) {
  $('meetingStatus').textContent = 'Комната не найдена';
  $('callLoading').querySelector('h1').textContent = 'Встреча не найдена';
  $('callLoading').querySelector('p').textContent = 'Вернитесь на главную и создайте новую встречу.';
} else {
  const frame = document.createElement('iframe');
  const roomURL = new URL(room);
  if (name) roomURL.searchParams.set('name', name);
  frame.allow = 'camera; microphone; autoplay; fullscreen; display-capture';
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.src = roomURL.toString();
  frame.onload = () => {
    $('meetingStatus').textContent = 'В эфире';
    $('callLoading')?.remove();
  };
  document.querySelector('.call-frame-wrap').append(frame);
}
