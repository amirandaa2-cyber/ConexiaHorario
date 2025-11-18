const http = require('http');
setTimeout(()=>{
  http.get('http://localhost:3002/examples/timegrid-views.html', (res) => {
    console.log('statusCode', res.statusCode);
    let len = 0;
    res.on('data', d=> len += d.length);
    res.on('end', ()=> console.log('length', len));
  }).on('error', e=> { console.error('error', e.message); process.exit(1); });
}, 400);
