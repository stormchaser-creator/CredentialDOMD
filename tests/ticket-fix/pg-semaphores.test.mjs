import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../../scripts/ticket-fix/pg-semaphores.c', import.meta.url));
// Actual C implementation with deterministic kernel calls, no host IPC writes.
const harness = `
#include <sys/types.h>
#include <sys/ipc.h>
#include <sys/sem.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int fake_semget(key_t,int,int);int fake_semctl(int,int,int,...);int fake_kill(pid_t,int);
#define semget fake_semget
#define semctl fake_semctl
#define kill fake_kill
#define main cleanup_main
#include ${JSON.stringify(source)}
#undef main
#undef semget
#undef semctl
#undef kill
static const char *scenario;static int removed=0,private_calls=0,stat_calls=0,invalid_flags=0;
int fake_semget(key_t key,int size,int flags){
 if(key==IPC_PRIVATE)private_calls++;if(flags!=0||size!=20)invalid_flags++;
 if((unsigned)key==12346U)return !strcmp(scenario,"key-changed")&&stat_calls>1?78:77;
 errno=ENOENT;return -1;
}
int fake_kill(pid_t pid,int sig){
 if(sig!=0||pid<=0)abort();if(!strcmp(scenario,"live"))return 0;
 errno=!strcmp(scenario,"eperm")?EPERM:ESRCH;return -1;
}
int fake_semctl(int id,int slot,int cmd,...){
 if(id!=77)abort();
 if(cmd==IPC_STAT){stat_calls++;if(!strcmp(scenario,"unreadable")){errno=EACCES;return -1;}
  va_list v;va_start(v,cmd);union qa_semun a=va_arg(v,union qa_semun);va_end(v);
  memset(a.buf,0,sizeof(*a.buf));a.buf->sem_nsems=!strcmp(scenario,"wrong-size")?21:20;
  a.buf->sem_perm.uid=getuid();a.buf->sem_perm.cuid=!strcmp(scenario,"foreign")?getuid()+1:getuid();
  a.buf->sem_perm.mode=!strcmp(scenario,"wrong-mode")?0644:01600;
  a.buf->sem_ctime=!strcmp(scenario,"changed-time")?stat_calls:1;a.buf->sem_otime=2;return 0;
 }
 if(cmd==GETVAL){if(slot==19)return !strcmp(scenario,"wrong-marker")?536:537;return !strcmp(scenario,"changed-value")&&stat_calls>1?2:1;}
 if(cmd==GETPID)return !strcmp(scenario,"zero-creator")&&slot==19?0:700001;
 if(cmd==GETNCNT)return !strcmp(scenario,"waiter")&&slot==4?1:0;
 if(cmd==GETZCNT)return !strcmp(scenario,"zero-waiter")&&slot==4?1:0;
 if(cmd==IPC_RMID){removed++;return 0;}abort();
}
int main(int argc,char **argv){
 if(argc!=3)return 2;scenario=argv[1];char *input[]={"helper","--remove",argv[2]};
 int code=cleanup_main(3,input);
 printf("{\\"code\\":%d,\\"removed\\":%d,\\"privateCalls\\":%d,\\"invalidFlags\\":%d}\\n",code,removed,private_calls,invalid_flags);return 0;
}`;
let directory, binary;
test.before(() => {
 directory=fs.mkdtempSync(path.join(os.tmpdir(),'pg-semaphore-kernel-'));
 const file=path.join(directory,'test.c');fs.writeFileSync(file,harness);binary=path.join(directory,'test');
 const r=spawnSync('/usr/bin/cc',['-std=c99','-Wall','-Wextra',file,'-o',binary],{encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);
});
test.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
function run(scenario,inode='12345') {
 const r=spawnSync(binary,[scenario,inode],{encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim().split('\n').at(-1));
}
test('unchanged own PostgreSQL semaphore with dead users is removed once',()=>assert.deepEqual(run('valid'),{code:0,removed:1,privateCalls:0,invalidFlags:0}));
for(const scenario of ['live','eperm','unreadable','foreign','wrong-size','wrong-mode','wrong-marker','zero-creator','waiter','zero-waiter','changed-time','changed-value','key-changed'])
 test(`${scenario} state remains untouched`,()=>assert.deepEqual(run(scenario),{code:0,removed:0,privateCalls:0,invalidFlags:0}));
test('wrapped IPC_PRIVATE key never reaches semget even with flags0',()=>assert.deepEqual(run('valid','4294967295'),{code:0,removed:0,privateCalls:0,invalidFlags:0}));
test('invalid or overflowing inode arguments are rejected before IPC lookups',()=>{
 for(const inode of ['0','-1','1x','18446744073709551616'])assert.deepEqual(run('valid',inode),{code:2,removed:0,privateCalls:0,invalidFlags:0});
});
