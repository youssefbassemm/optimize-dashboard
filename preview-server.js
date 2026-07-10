const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT   = process.env.PORT || 4001;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

http.createServer(function (req, res) {
  let url = req.url.split('?')[0];
  if (url === '/' || url === '/food-brand') url = '/food-brand.html';
  const filePath = path.join(PUBLIC, url);
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, function () {
  console.log('Preview server on http://localhost:' + PORT);
});
