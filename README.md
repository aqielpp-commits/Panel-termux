# Ptero-Termux

## Install (Termux)
```
pkg update && pkg install nodejs cloudflared -y
cd ptero-termux
npm install
npm start
```
Password admin otomatis tampil di log pertama kali jalan (username: `admin`).

## Config (config.json, dibuat otomatis)
- `telegramToken`: token dari @BotFather
- `adminTgIds`: [ID Telegram kamu]
- `plans`: daftar tombol RAM di bot
- `cloudflared`: true = URL acak trycloudflare.com otomatis; `domain`: isi kalau punya domain sendiri
- `maxServersPerTgUser`: batas server per user Telegram

Perintah bot: /start (pilih paket), /panel, admin: /list, /del <kode>

## File .env
Setiap server punya tab Env (.env). Isi dengan format KEY=VALUE, satu per baris. Isinya dimuat saat server di-start dan masuk ke process.env. Restart server setelah mengubah.

## Upload file besar
Upload di-stream langsung ke disk, tanpa batas ukuran dari panel. Progress bar ditampilkan saat upload.
