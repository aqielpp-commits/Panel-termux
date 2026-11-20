const fs=require('fs'),path=require('path'),crypto=require('crypto'),http=require('http');
const {spawn}=require('child_process');
const express=require('express');const {WebSocketServer}=require('ws');const AdmZip=require('adm-zip');
const ROOT=__dirname,DATA=process.env.DATA_DIR||path.join(ROOT,'data'),SRV=path.join(DATA,'servers');
fs.mkdirSync(SRV,{recursive:true});
const CFG_F=path.join(ROOT,'config.json');
const def={port:3000,telegramToken:"",adminTgIds:[],maxServersPerTgUser:1,cloudflared:true,domain:"",
 plans:[{label:"1 GB RAM",ram:1024},{label:"2 GB RAM",ram:2048},{label:"3 GB RAM",ram:3072},{label:"5 GB RAM",ram:5120}]};
const cfg={...def,...(fs.existsSync(CFG_F)?JSON.parse(fs.readFileSync(CFG_F)):{})};
if(!fs.existsSync(CFG_F))fs.writeFileSync(CFG_F,JSON.stringify(cfg,null,2));
if(process.env.PORT)cfg.port=+process.env.PORT;
if(process.env.TG_TOKEN)cfg.telegramToken=process.env.TG_TOKEN;
if(process.env.ADMIN_TG_IDS)cfg.adminTgIds=process.env.ADMIN_TG_IDS.split(',').map(x=>x.trim()).filter(Boolean);
if(process.env.CLOUDFLARED==='0')cfg.cloudflared=false;
let publicUrl=process.env.PUBLIC_URL?process.env.PUBLIC_URL.replace(/\/$/,''):(cfg.domain||`http://localhost:${cfg.port}`);

const TYPES={
  node:{label:'Node.js',startup:'npm install && npm start'},
  python:{label:'Python',startup:'[ -f requirements.txt ] && pip install -r requirements.txt; python3 main.py'},
  web:{label:'Web statis',startup:''}
};
const typeOf=s=>(s&&TYPES[s.type])?s.type:'node';

// ---------- DB ----------
const DB_F=path.join(DATA,'db.json');
const db=fs.existsSync(DB_F)?JSON.parse(fs.readFileSync(DB_F)):{users:[],servers:[]};
const save=()=>fs.writeFileSync(DB_F,JSON.stringify(db,null,1));
const rnd=n=>crypto.randomBytes(n).toString('hex');
const hash=(p,s=rnd(8))=>s+':'+crypto.scryptSync(p,s,32).toString('hex');
const check=(p,h)=>{const [s]=h.split(':');return crypto.timingSafeEqual(Buffer.from(hash(p,s)),Buffer.from(h))};
function addUser(username,password,admin=false,tg=null){
  if(db.users.find(u=>u.username===username))throw new Error('Username sudah ada');
  const u={id:rnd(4),username,pass:hash(password),admin,tg};db.users.push(u);save();return u}
if(!db.users.length){const pw=rnd(5);addUser('admin',pw,true);
  console.log(`\n=== ADMIN DIBUAT ===\nUsername: admin\nPassword: ${pw}\n====================\n`)}

// ---------- Server manager ----------
const procs={};
const P=id=>procs[id]||(procs[id]={p:null,logs:[],status:'offline',clients:new Set(),last:null});
const strip=s=>s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');
const dirOf=id=>path.join(SRV,id);
function emit(id,m){const s=JSON.stringify(m);P(id).clients.forEach(c=>c.readyState===1&&c.send(s))}
function log(id,t){const o=P(id);t.split(/\r?\n/).forEach(l=>{if(l===''&&t!=='\n')return;o.logs.push(l);if(o.logs.length>600)o.logs.shift();emit(id,{t:'log',d:l})})}
function setStatus(id,s){P(id).status=s;emit(id,{t:'status',d:s})}
function nextPort(){let p=20000;for(const s of db.servers)if(s.port>=p)p=s.port+1;return p}

function loadEnv(dir){const f=path.join(dir,'.env'),o={};if(!fs.existsSync(f))return o;
  for(const l of fs.readFileSync(f,'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if(m)o[m[1]]=m[2].replace(/^(["'])(.*)\1$/,'$2')}
  return o}

function startSrv(id){
  const o=P(id),s=db.servers.find(x=>x.id===id);
  if(!s)return;
  if(typeOf(s)==='web'){o.status='running';return}
  if(o.p)return;
  if(!s.port){s.port=nextPort();save()}
  log(id,'[panel] Server ditandai untuk mulai...');
  setStatus(id,'starting');
  const p=spawn('sh',['-c',s.startup||'echo "Tidak ada startup command"'],{cwd:dirOf(id),detached:true,
    env:{...process.env,PORT:String(s.port),...loadEnv(dirOf(id)),NODE_OPTIONS:`--max-old-space-size=${s.ram}`,SERVER_MEMORY:String(s.ram),SERVER_ID:id}});
  o.p=p;o.last=null;
  p.stdout.on('data',d=>{o.prompt=!/\n$/.test(d.toString());log(id,strip(d.toString()));setStatus(id,'running')});
  p.stderr.on('data',d=>{o.prompt=!/\n$/.test(d.toString());log(id,strip(d.toString()))});
  p.on('close',c=>{o.p=null;o.last=null;log(id,`[panel] Proses berhenti dengan kode ${c}`);setStatus(id,'offline')});
  p.on('error',e=>{o.p=null;o.last=null;log(id,'[panel] '+e.message);setStatus(id,'offline')});
}
function stopSrv(id,sig='SIGTERM'){const o=P(id);if(!o.p)return;
  try{process.kill(-o.p.pid,sig)}catch{try{o.p.kill(sig)}catch{}}
  if(sig==='SIGTERM'){setStatus(id,'stopping');setTimeout(()=>o.p&&stopSrv(id,'SIGKILL'),10000)}}

function createServer({name,owner,ram,startup,type,autostart}){
  const t=TYPES[type]?type:'node';
  const id=rnd(4);const d=dirOf(id);fs.mkdirSync(d,{recursive:true});
  fs.writeFileSync(path.join(d,'.env'),'# Variabel environment server ini. Format: KEY=VALUE\n');
  if(t==='node'){
    fs.writeFileSync(path.join(d,'package.json'),JSON.stringify({name:'bot',version:'1.0.0',scripts:{start:'node index.js'},dependencies:{}},null,2));
    fs.writeFileSync(path.join(d,'index.js'),"console.log('Server Node.js siap! Upload file kamu di tab Files, lalu Restart.');setInterval(()=>{},1e5);\n");
  }else if(t==='python'){
    fs.writeFileSync(path.join(d,'requirements.txt'),'# Tulis dependency Python di sini, satu per baris\n');
    fs.writeFileSync(path.join(d,'main.py'),"import time\nprint('Server Python siap! Upload script kamu di tab Files, lalu Restart.')\nwhile True:\n    time.sleep(100)\n");
  }else{
    fs.writeFileSync(path.join(d,'index.html'),'<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website</title></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Website kamu sudah online</h1><p>Upload file website kamu di tab Files.</p></body></html>\n');
  }
  const s={id,name:name||'Server',owner,type:t,ram:+ram||1024,port:nextPort(),
    startup:startup||TYPES[t].startup,autostart:autostart!==false,created:Date.now()};
  db.servers.push(s);save();
  if(t==='web')P(id).status='running';
  return s}
function deleteServer(id){stopSrv(id,'SIGKILL');fs.rmSync(dirOf(id),{recursive:true,force:true});
  db.servers=db.servers.filter(s=>s.id!==id);delete procs[id];save()}

// ---------- Statistik CPU & RAM (baca /proc) ----------
const CLK=100;
function treeOf(root){const map={};
  try{for(const d of fs.readdirSync('/proc')){if(!/^\d+$/.test(d))continue;
    try{const st=fs.readFileSync('/proc/'+d+'/stat','utf8');const f=st.slice(st.lastIndexOf(')')+2).split(' ');
      map[d]={ppid:f[1],ut:+f[11],st:+f[12]}}catch{}}}catch{}
  const kids={};for(const k in map){(kids[map[k].ppid]=kids[map[k].ppid]||[]).push(k)}
  const out=[],q=[String(root)];
  while(q.length){const c=q.pop();if(map[c])out.push({pid:c,...map[c]});(kids[c]||[]).forEach(x=>q.push(x))}
  return out}
function stats(id){const o=P(id);if(!o.p)return{cpu:0,ram:0};
  let ticks=0,pages=0;
  for(const x of treeOf(o.p.pid)){ticks+=x.ut+x.st;
    try{pages+=+fs.readFileSync('/proc/'+x.pid+'/statm','utf8').split(' ')[1]}catch{}}
  const now=Date.now(),prev=o.last;o.last={t:now,ticks};
  let cpu=0;if(prev&&now>prev.t)cpu=((ticks-prev.ticks)/CLK)/((now-prev.t)/1000)*100;
  return{cpu:Math.max(0,+cpu.toFixed(1)),ram:Math.round(pages*4096/1048576)}}
setInterval(()=>{for(const id in procs){const o=procs[id];if(!o.p||!o.clients.size)continue;
  const s=db.servers.find(x=>x.id===id);emit(id,{t:'stats',...stats(id),limit:s?s.ram:0})}},2000);

// ---------- Console: jalankan perintah Termux bebas ----------
// Perintah Termux yang dikenali. Teks yang diawali kata-kata ini dianggap perintah shell, bukan input bot.
const SHELL_RE=/^(pkg|apt|apt-get|npm|npx|yarn|pnpm|node|pip|pip3|python|python3|git|ls|cd|cat|cp|mv|rm|rmdir|mkdir|touch|nano|vim|echo|clear|pwd|kill|killall|ps|top|htop|curl|wget|unzip|zip|tar|chmod|chown|grep|find|head|tail|sed|awk|sh|bash|exit|df|du|free|ifconfig|ip|ping|env|export|source|which|history|sudo|gcc|make|java|nohup|screen|tmux|ssh|scp|rsync|man|help|date|uname|whoami|cloudflared|termux-\S+)(\s|$)/i;

// Routing input console:
// 1. Ada perintah shell berjalan -> input ke perintah itu (jawaban y/n, dll).
// 2. Awalan $ -> selalu shell. Awalan ! -> selalu bot.
// 3. Bot berjalan dan sedang menunggu input (prompt), atau teks bukan perintah Termux -> bot.
// 4. Selain itu -> shell.
function runCmd(id,raw){
  const o=P(id);
  if(!o.cwd)o.cwd=dirOf(id);
  const line=String(raw);
  const t0=line.trim();
  if(o.cmd&&!t0.startsWith('$')){log(id,'> '+t0);if(o.cmd.stdin.writable)o.cmd.stdin.write(t0+'\n');return}
  const forceShell=t0.startsWith('$'),forceBot=t0.startsWith('!');
  const body=forceShell?t0.slice(1).trim():forceBot?t0.slice(1).trim():t0;
  const botUp=!!(o.p&&o.p.stdin.writable);
  const toBot=forceBot||(!forceShell&&botUp&&(o.prompt||!SHELL_RE.test(body)));
  if(toBot){
    if(botUp){o.prompt=false;log(id,'> '+body);o.p.stdin.write(body+'\n')}
    else log(id,'[panel] Server belum berjalan. Tekan Start dulu.');
    return}
  if(!body)return;
  log(id,'$ '+body);
  if(body==='clear'){o.logs.length=0;emit(id,{t:'clear'});return}
  if(body==='cd'||body.startsWith('cd ')){
    let arg=body.slice(2).trim();if(!arg||arg==='~')arg=process.env.HOME||'/';
    const target=path.resolve(o.cwd,arg.replace(/^~(?=\/|$)/,process.env.HOME||'/'));
    if(fs.existsSync(target)&&fs.statSync(target).isDirectory())o.cwd=target;
    else log(id,'cd: folder tidak ditemukan: '+arg);
    return}
  const shell=process.env.SHELL||'sh';
  const c=spawn(shell,['-c',body],{cwd:o.cwd,detached:true,env:{...process.env,TERM:'dumb'}});
  o.cmd=c;
  c.stdout.on('data',d=>log(id,strip(d.toString())));
  c.stderr.on('data',d=>log(id,strip(d.toString())));
  c.on('close',code=>{if(o.cmd===c)o.cmd=null;log(id,`[selesai dengan kode ${code}]`)});
  c.on('error',e=>{if(o.cmd===c)o.cmd=null;log(id,'[error] '+e.message)});
}
function stopCmd(id){const o=P(id);if(!o.cmd)return;
  try{process.kill(-o.cmd.pid,'SIGINT')}catch{try{o.cmd.kill('SIGINT')}catch{}}
  log(id,'^C');}

// ---------- HTTP ----------
const app=express();
const cookies=h=>Object.fromEntries((h||'').split(';').map(x=>x.trim().split('=')).filter(x=>x[0]).map(([k,...v])=>[k,v.join('=')]));
const sessions={};
const userOf=req=>{const t=cookies(req.headers.cookie).tok;const id=sessions[t];return db.users.find(u=>u.id===id)};
const auth=(req,res,next)=>{const u=userOf(req);if(!u)return res.status(401).json({error:'Belum login'});req.user=u;next()};
const adminOnly=(req,res,next)=>req.user.admin?next():res.status(403).json({error:'Khusus admin'});
const srvAccess=(req,res,next)=>{const s=db.servers.find(x=>x.id===req.params.id);
  if(!s||!(req.user.admin||s.owner===req.user.id))return res.status(404).json({error:'Server tidak ditemukan'});req.srv=s;next()};
const safe=(id,p='/')=>{const b=dirOf(id),r=path.resolve(b,'.'+path.posix.join('/',p));if(r!==b&&!r.startsWith(b+path.sep))throw new Error('Path tidak valid');return r};
const wrap=f=>(req,res)=>{try{f(req,res)}catch(e){res.status(400).json({error:e.message})}};
const pub=s=>{const t=typeOf(s);return{...s,type:t,typeLabel:TYPES[t].label,status:P(s.id).status,
  address:`${publicUrl}/#/server/${s.id}`,
  siteUrl:t==='web'?`${publicUrl}/s/${s.id}/`:`${publicUrl}/p/${s.id}/`,
  ownerName:(db.users.find(u=>u.id===s.owner)||{}).username}};

// Website statis dan proxy aplikasi. Dipasang sebelum express.json agar body upload/proxy tidak terbaca dua kali.
app.use('/s/:id',(req,res,next)=>{const s=db.servers.find(x=>x.id===req.params.id);
  if(!s||typeOf(s)!=='web')return next();
  express.static(dirOf(s.id))(req,res,next)});
app.use('/p/:id',(req,res)=>{const s=db.servers.find(x=>x.id===req.params.id);
  if(!s||typeOf(s)==='web')return res.status(404).send('Tidak ditemukan');
  if(!P(s.id).p)return res.status(503).send('Server belum berjalan. Tekan Start di panel.');
  const pr=http.request({host:'127.0.0.1',port:s.port,method:req.method,path:req.url,headers:req.headers},up=>{
    res.writeHead(up.statusCode,up.headers);up.pipe(res)});
  pr.on('error',()=>{if(!res.headersSent)res.status(502).send('Aplikasi belum listen di port PORT')});
  req.pipe(pr)});

app.use(express.json());
app.post('/api/login',wrap((req,res)=>{const {username,password}=req.body;
  const u=db.users.find(x=>x.username===username);
  if(!u||!check(password||'',u.pass))return res.status(401).json({error:'Username atau password salah'});
  const t=rnd(24);sessions[t]=u.id;res.setHeader('Set-Cookie',`tok=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
  res.json({ok:true})}));
app.post('/api/logout',(req,res)=>{delete sessions[cookies(req.headers.cookie).tok];res.json({ok:true})});
app.get('/api/me',auth,(req,res)=>res.json({id:req.user.id,username:req.user.username,admin:req.user.admin,publicUrl}));
app.get('/api/types',auth,(req,res)=>res.json(Object.entries(TYPES).map(([k,v])=>({id:k,label:v.label}))));

app.get('/api/servers',auth,(req,res)=>res.json(db.servers.filter(s=>req.user.admin||s.owner===req.user.id).map(pub)));
app.post('/api/servers',auth,adminOnly,wrap((req,res)=>{
  const o=db.users.find(u=>u.id===req.body.owner);if(!o)throw new Error('Owner tidak ada');
  res.json(pub(createServer(req.body)))}));
app.get('/api/servers/:id',auth,srvAccess,(req,res)=>res.json(pub(req.srv)));
app.delete('/api/servers/:id',auth,adminOnly,srvAccess,(req,res)=>{deleteServer(req.srv.id);res.json({ok:true})});
app.put('/api/servers/:id/startup',auth,srvAccess,(req,res)=>{
  if(req.body.startup!==undefined)req.srv.startup=String(req.body.startup).slice(0,500);
  if(req.body.autostart!==undefined)req.srv.autostart=!!req.body.autostart;
  save();res.json({ok:true})});
app.post('/api/servers/:id/power',auth,srvAccess,(req,res)=>{const id=req.srv.id,a=req.body.action;
  if(typeOf(req.srv)==='web')return res.json({ok:true});
  if(a==='start')startSrv(id);else if(a==='stop')stopSrv(id);else if(a==='kill')stopSrv(id,'SIGKILL');
  else if(a==='restart'){stopSrv(id);const t=setInterval(()=>{if(!P(id).p){clearInterval(t);startSrv(id)}},500)}
  res.json({ok:true})});

app.get('/api/users',auth,adminOnly,(req,res)=>res.json(db.users.map(u=>({id:u.id,username:u.username,admin:u.admin,tg:u.tg}))));
app.post('/api/users',auth,adminOnly,wrap((req,res)=>{const {username,password,admin}=req.body;
  if(!username||!password)throw new Error('Isi username & password');addUser(username,password,!!admin);res.json({ok:true})}));
app.delete('/api/users/:id',auth,adminOnly,wrap((req,res)=>{
  if(req.params.id===req.user.id)throw new Error('Tidak bisa hapus diri sendiri');
  db.servers.filter(s=>s.owner===req.params.id).forEach(s=>deleteServer(s.id));
  db.users=db.users.filter(u=>u.id!==req.params.id);save();res.json({ok:true})}));

// files
const F='/api/servers/:id/files';
app.get(F,auth,srvAccess,wrap((req,res)=>{const d=safe(req.srv.id,req.query.path);
  res.json(fs.readdirSync(d,{withFileTypes:true}).map(e=>{const st=fs.statSync(path.join(d,e.name));
    return {name:e.name,dir:e.isDirectory(),size:st.size,mtime:st.mtimeMs}}).sort((a,b)=>b.dir-a.dir||a.name.localeCompare(b.name)))}));
app.get(F+'/read',auth,srvAccess,wrap((req,res)=>{const f=safe(req.srv.id,req.query.path);
  if(fs.statSync(f).size>5e6)throw new Error('File terlalu besar untuk diedit (>5MB). Gunakan Unduh.');res.type('text/plain').send(fs.readFileSync(f,'utf8'))}));
app.get(F+'/download',auth,srvAccess,wrap((req,res)=>res.download(safe(req.srv.id,req.query.path))));
app.put(F+'/write',auth,srvAccess,express.text({type:'*/*',limit:'20mb'}),wrap((req,res)=>{fs.writeFileSync(safe(req.srv.id,req.query.path),req.body||'');res.json({ok:true})}));
app.post(F+'/mkdir',auth,srvAccess,wrap((req,res)=>{fs.mkdirSync(safe(req.srv.id,req.body.path),{recursive:true});res.json({ok:true})}));
app.post(F+'/delete',auth,srvAccess,wrap((req,res)=>{for(const p of req.body.paths)fs.rmSync(safe(req.srv.id,p),{recursive:true,force:true});res.json({ok:true})}));
// upload di-stream langsung ke disk, jadi file besar tidak memenuhi RAM
app.post(F+'/upload',auth,srvAccess,wrap((req,res)=>{
  const dir=safe(req.srv.id,req.query.path),f=path.join(dir,path.basename(req.query.name||'file'));
  const out=fs.createWriteStream(f);
  out.on('error',e=>{if(!res.headersSent)res.status(500).json({error:e.message})});
  out.on('finish',()=>res.json({ok:true}));
  req.pipe(out)}));
// ekstrak zip (entri di luar folder tujuan ditolak)
app.post(F+'/unzip',auth,srvAccess,wrap((req,res)=>{
  const zf=safe(req.srv.id,req.body.path);
  const dest=path.dirname(zf);
  const z=new AdmZip(zf);let n=0;
  for(const e of z.getEntries()){
    const t=path.resolve(dest,e.entryName);
    if(t!==dest&&!t.startsWith(dest+path.sep))throw new Error('Entri zip tidak aman: '+e.entryName);
    if(e.isDirectory){fs.mkdirSync(t,{recursive:true});continue}
    fs.mkdirSync(path.dirname(t),{recursive:true});
    fs.writeFileSync(t,e.getData());n++}
  res.json({ok:true,files:n})}));

app.use(express.static(path.join(ROOT,'public')));

// ---------- Perintah bebas (shell Termux di folder server) ----------
function runCmd(id,cmd){
  const o=P(id);
  if(!cmd)return;
  // awalan ! = kirim ke stdin proses server yang sedang berjalan (misalnya input bot)
  if(cmd.startsWith('!')){
    if(o.p&&o.p.stdin.writable){o.p.stdin.write(cmd.slice(1)+'\n');log(id,'> '+cmd.slice(1))}
    else log(id,'[panel] Server tidak berjalan, input stdin diabaikan');
    return}
  if(o.job){log(id,'[panel] Masih ada perintah yang berjalan. Tunggu selesai atau tekan Stop.');return}
  let c=cmd;
  if(/^pkg install\b/.test(c)&&!/(^|\s)-y(\s|$)/.test(c))c=c.replace(/^pkg install/,'pkg install -y');
  log(id,'$ '+cmd);
  const j=spawn('sh',['-c',c],{cwd:dirOf(id),detached:true,stdio:['ignore','pipe','pipe'],
    env:{...process.env,DEBIAN_FRONTEND:'noninteractive'}});
  o.job=j;
  const out=d=>log(id,strip(d.toString()));
  j.stdout.on('data',out);j.stderr.on('data',out);
  j.on('close',code=>{o.job=null;log(id,`[panel] Perintah selesai (kode ${code})`)});
  j.on('error',e=>{o.job=null;log(id,'[panel] '+e.message)});
}
function stopCmd(id){const o=P(id);if(!o.job)return;
  try{process.kill(-o.job.pid,'SIGINT')}catch{try{o.job.kill('SIGINT')}catch{}}
  log(id,'[panel] Perintah dihentikan')}

// ---------- WebSocket console ----------
const server=http.createServer(app);
server.requestTimeout=0;server.headersTimeout=0;server.timeout=0;
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,sock,head)=>{
  const u=userOf(req),url=new URL(req.url,'http://x'),id=url.searchParams.get('id');
  const s=db.servers.find(x=>x.id===id);
  if(url.pathname!=='/ws'||!u||!s||!(u.admin||s.owner===u.id))return sock.destroy();
  wss.handleUpgrade(req,sock,head,ws=>{
    const o=P(id);o.clients.add(ws);
    ws.send(JSON.stringify({t:'init',logs:o.logs,status:o.status,stats:stats(id),limit:s.ram}));
    ws.on('message',m=>{try{const j=JSON.parse(m);
      if(j.t==='cmd')runCmd(id,String(j.d));
      else if(j.t==='ctrl')stopCmd(id)}catch{}});
    ws.on('close',()=>o.clients.delete(ws))})});

// ---------- Telegram bot ----------
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const tg=async(m,b)=>{const r=await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/${m}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return r.json()};
const isTgAdmin=id=>cfg.adminTgIds.map(String).includes(String(id));
const menu=()=>({inline_keyboard:cfg.plans.map(p=>[{text:'🖥 '+p.label,callback_data:'buy:'+p.ram}])});
async function tgHandle(u){
  if(u.message&&u.message.text){const m=u.message,t=m.text.split(' ')[0],c=m.chat.id;
    if(t==='/start'||t==='/buat')return tg('sendMessage',{chat_id:c,text:'Selamat datang! Pilih paket server bot WhatsApp kamu:',reply_markup:menu()});
    if(t==='/panel')return tg('sendMessage',{chat_id:c,text:'Panel: '+publicUrl});
    if(isTgAdmin(c)&&t==='/list')return tg('sendMessage',{chat_id:c,text:db.servers.map(s=>`${s.id} | ${s.name} | ${typeOf(s)} | ${s.ram}MB | ${P(s.id).status}`).join('\n')||'Kosong'});
    if(isTgAdmin(c)&&t==='/del'){const id=m.text.split(' ')[1];if(db.servers.find(s=>s.id===id)){deleteServer(id);return tg('sendMessage',{chat_id:c,text:'Dihapus '+id})}}
  }
  if(u.callback_query){const q=u.callback_query,c=q.from.id;await tg('answerCallbackQuery',{callback_query_id:q.id});
    if(!q.data.startsWith('buy:'))return;
    const ram=+q.data.slice(4);if(!cfg.plans.find(p=>p.ram===ram))return;
    let user=db.users.find(x=>x.tg===String(c)),pw=null;
    const own=user?db.servers.filter(s=>s.owner===user.id).length:0;
    if(own>=cfg.maxServersPerTgUser&&!isTgAdmin(c))return tg('sendMessage',{chat_id:c,text:`Batas ${cfg.maxServersPerTgUser} server per akun tercapai.`});
    if(!user){pw=rnd(4);user=addUser('user'+rnd(3),pw,false,String(c))}
    const s=createServer({name:`Bot-${ram/1024}GB`,owner:user.id,ram,type:'node'});
    await tg('sendMessage',{chat_id:c,parse_mode:'HTML',text:`<b>Server dibuat</b>\n\nRAM: ${ram} MB\nKode Server: <code>${s.id}</code>\nAddress: ${publicUrl}/#/server/${s.id}\n\nUsername: <code>${user.username}</code>\nPassword: ${pw?`<code>${pw}</code>`:'(pakai password akunmu yang lama)'}\n\nLogin ke panel, upload bot di tab Files, lalu tekan Start.`})}
}
async function tgPoll(){let off=0;console.log('[telegram] bot aktif');
  for(;;){try{const r=await tg('getUpdates',{offset:off,timeout:30,allowed_updates:['message','callback_query']});
    for(const u of r.result||[]){off=u.update_id+1;tgHandle(u).catch(e=>console.log('[tg]',e.message))}}catch{await sleep(5000)}}}
const notifyAdmins=t=>cfg.telegramToken&&cfg.adminTgIds.forEach(i=>tg('sendMessage',{chat_id:i,text:t}).catch(()=>{}));

// ---------- Cloudflared ----------
function startTunnel(){
  const p=spawn('cloudflared',['tunnel','--url',`http://localhost:${cfg.port}`,'--no-autoupdate']);
  p.on('error',()=>console.log('[cloudflared] belum terpasang. Jalankan: pkg install cloudflared'));
  const onD=d=>{const m=d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if(m&&publicUrl!==m[0]){publicUrl=m[0];console.log('[cloudflared] URL publik:',publicUrl);notifyAdmins('Panel online: '+publicUrl)}};
  p.stdout.on('data',onD);p.stderr.on('data',onD);
  p.on('close',()=>setTimeout(startTunnel,5000));
}

server.listen(cfg.port,()=>{
  console.log(`Panel jalan di http://localhost:${cfg.port}`);
  // autostart: web statis selalu hidup, lainnya jalan otomatis jika autostart aktif
  for(const s of db.servers){
    if(typeOf(s)==='web')P(s.id).status='running';
    else if(s.autostart!==false)startSrv(s.id);
  }
  if(cfg.telegramToken)tgPoll();
  if(cfg.cloudflared&&!cfg.domain)startTunnel();
});
process.on('SIGINT',()=>{db.servers.forEach(s=>stopSrv(s.id,'SIGKILL'));process.exit()});
