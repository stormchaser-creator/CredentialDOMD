/* Only the recorded directory's bounded PostgreSQL semaphore keys are visited.
 * No host-wide enumeration or process signal other than kill(pid, 0).
 * sysv_sema.c (PostgreSQL17): 19 useful entries + marker537, creator in slot19.
 */
#include <sys/types.h>
#include <sys/ipc.h>
#include <sys/sem.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

union qa_semun { int val; struct semid_ds *buf; unsigned short *array; };
struct observed {
    struct semid_ds ds;
    int values[20], pids[20], waiting[20], zero_waiting[20];
};
static int gone(int pid) {
    if (pid <= 0) return 0;
    errno = 0;
    return kill(pid, 0) == -1 && errno == ESRCH;
}
static int read_owned(int id, key_t key, struct observed *out) {
    union qa_semun arg;
    if (key == IPC_PRIVATE || id < 0) return 0; /* semget(key0) creates even with flags0 */
    memset(out, 0, sizeof(*out));
    arg.buf = &out->ds;
    if (semctl(id, 0, IPC_STAT, arg) < 0 || semget(key, 20, 0) != id) return 0;
    if (out->ds.sem_nsems != 20 || out->ds.sem_perm.uid != getuid() || out->ds.sem_perm.cuid != getuid()
        || (out->ds.sem_perm.mode & 0777) != 0600) return 0;
    for (int i = 0; i < 20; i++) {
        out->values[i] = semctl(id, i, GETVAL, arg);
        out->pids[i] = semctl(id, i, GETPID, arg);
        out->waiting[i] = semctl(id, i, GETNCNT, arg);
        out->zero_waiting[i] = semctl(id, i, GETZCNT, arg);
        if (out->values[i] < 0 || out->pids[i] < 0 || out->waiting[i] != 0 || out->zero_waiting[i] != 0) return 0;
        if (out->pids[i] > 0 && !gone(out->pids[i])) return 0;
    }
    return out->values[19] == 537 && gone(out->pids[19]);
}
static int same(const struct observed *a, const struct observed *b) {
    return a->ds.sem_perm.uid == b->ds.sem_perm.uid && a->ds.sem_perm.cuid == b->ds.sem_perm.cuid
        && a->ds.sem_perm.mode == b->ds.sem_perm.mode && a->ds.sem_nsems == b->ds.sem_nsems
        && a->ds.sem_ctime == b->ds.sem_ctime && a->ds.sem_otime == b->ds.sem_otime
        && !memcmp(a->values, b->values, sizeof(a->values)) && !memcmp(a->pids, b->pids, sizeof(a->pids))
        && !memcmp(a->waiting, b->waiting, sizeof(a->waiting)) && !memcmp(a->zero_waiting, b->zero_waiting, sizeof(a->zero_waiting));
}
int main(int argc, char **argv) {
    if (argc < 3 || argc > 66 || (strcmp(argv[1], "--audit") && strcmp(argv[1], "--remove"))) return 2;
    const int remove = !strcmp(argv[1], "--remove");
    /* Validate the whole input before any lookup or removal. */
    uint64_t inodes[64];
    for (int n = 2; n < argc; n++) {
        if (!argv[n][0] || strlen(argv[n]) > 20 || strspn(argv[n], "0123456789") != strlen(argv[n])) return 2;
        char *end = NULL; errno = 0;
        unsigned long long parsed = strtoull(argv[n], &end, 10);
        if (errno || !end || *end || !parsed) return 2;
        inodes[n-2] = parsed;
    }
    for (int n = 0; n < argc-2; n++) {
        for (unsigned int offset = 1; offset <= 10; offset++) {
            const uint32_t key_bits = (uint32_t)inodes[n] + offset;
            if (!key_bits) continue;
            const key_t key = (key_t)key_bits;
            const int id = semget(key, 20, 0);
            struct observed before, after;
            if (!read_owned(id, key, &before)) continue;
            if (!read_owned(id, key, &after) || !same(&before, &after)) continue;
            if (remove) {
                union qa_semun arg; arg.val = 0;
                if (semctl(id, 0, IPC_RMID, arg) < 0) continue;
            }
            printf("{\"id\":%d,\"key\":%u,\"creatorPid\":%d,\"removed\":%s}\n", id, key_bits, before.pids[19], remove ? "true" : "false");
        }
    }
    return 0;
}
