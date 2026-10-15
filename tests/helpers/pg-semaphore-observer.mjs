// Independent read-only native observer for the exact test data-directory keys.
// Never enumerates host IPC objects or removes a semaphore.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let directory, binary, cleanupBinary;
const source = `
#include <sys/types.h>
#include <sys/ipc.h>
#include <sys/sem.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
union arg {int val;struct semid_ds *buf;unsigned short *array;};
int main(int argc,char **argv){
 if(argc!=2)return 2;
 uint32_t base=(uint32_t)strtoull(argv[1],NULL,10);
 for(uint32_t off=1;off<=10;off++){
  uint32_t key=base+off;if(!key)continue;
  int id=semget((key_t)key,20,0);if(id<0)continue;
  struct semid_ds ds;union arg a;a.buf=&ds;
  if(semctl(id,0,IPC_STAT,a)<0)continue;
  printf("%d %u %u %d %d\\n",id,key,(unsigned)ds.sem_nsems,semctl(id,19,GETVAL,a),semctl(id,19,GETPID,a));
 }
 return 0;
}`;
export function prepareSemaphoreObserver() {
  if (binary) return;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-semaphore-observer-'));
  fs.writeFileSync(path.join(directory, 'read.c'), source);
  binary = path.join(directory, 'read');
  const result = spawnSync('/usr/bin/cc', ['-std=c99', path.join(directory, 'read.c'), '-o', binary], { encoding: 'utf8', timeout: 20000 });
  if (result.status !== 0) throw Error(`Native semaphore observer compile failed: ${result.stderr}`);
  cleanupBinary = path.join(directory, 'cleanup');
  const cleanupSource = fileURLToPath(new URL('../../scripts/ticket-fix/pg-semaphores.c', import.meta.url));
  const cleanupBuild = spawnSync('/usr/bin/cc', ['-std=c99', cleanupSource, '-o', cleanupBinary], { encoding: 'utf8', timeout: 20000 });
  if (cleanupBuild.status !== 0) throw Error(`Native owned cleanup compile failed: ${cleanupBuild.stderr}`);
  process.once('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
}
export function semaphoreSets(inode) {
  prepareSemaphoreObserver();
  const result = spawnSync(binary, [String(inode)], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) throw Error('Native semaphore observer failed');
  return result.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [id, key, nsems, marker, creator] = line.split(' ').map(Number);
    return { id, key, nsems, marker, creator };
  });
}
// Counterfactual cleanup only: always the new scoped helper, even when the
// actual slot/host code under test is temporarily restored to old source.
export function cleanObservedSemaphoreFixture(inode) {
  prepareSemaphoreObserver();
  const r = spawnSync(cleanupBinary, ['--remove', String(inode)], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) throw Error('Owned counterfactual semaphore cleanup failed');
}
