const fs=require('node:fs');fs.writeFileSync('server.log',Array.from({length:50000},(_,i)=>i===42017?'42017 ERROR request_id=R-742 status=broken':`${i} INFO heartbeat ok`).join('\n')+'\n');
