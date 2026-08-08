# BloxWin — GitHub Pages + Roblox Login

Bu paket mevcut BloxWin sayfasının geri kalanını değiştirmeden Roblox doğrulamalı login'i GitHub Pages + backend şeklinde ayırır.

## 1. Backend'i yayınla

`server.js` ve `package.json` dosyalarını Render/Railway/Vercel gibi Node.js çalıştırabilen bir servise yükle.

Render örneği:
- Build: `npm install`
- Start: `npm start`
- Environment variable:
  `FRONTEND_URL=https://KULLANICIADIN.github.io/REPO-ADI`

Backend URL'sini aldıktan sonra örneğin:
`https://bloxwin-roblox-api.onrender.com`

## 2. GitHub Pages

GitHub reposuna şu üç frontend dosyasını koy:
- `index.html`
- `config.js`

`config.js` içindeki:
`https://YOUR-BACKEND-URL-HERE`

kısmını gerçek backend URL'in ile değiştir.

Sonra GitHub Pages'i `main` branch / root üzerinden aç.

## 3. Akış

Login with Roblox → username → hesap onayı → 9 haneli kod → Roblox About/Description → Verify & Login.

Şifre istenmez.

## Önemli

- `server.js` GitHub Pages'e koyulmaz; Node backend olarak ayrı yayınlanır.
- `FRONTEND_URL` GitHub Pages adresin olmalıdır.
- Production'da HTTPS kullan.
- Backend'deki doğrulama challenge'ları sunucu belleğinde tutulur; backend yeniden başlarsa aktif doğrulamalar sıfırlanır.


## Verification code format

Doğrulama kodu artık rakam yerine 9 büyük harften oluşur (ör. `QZKMPTRVX`).
Bu format uzun sayı dizilerinin Roblox tarafından sansürlenmesi sorununu azaltmak için kullanılır.
