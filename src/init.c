/**
 * This serves as a minimal init daemon inside each sandbox. It mainly exists
 * to keep the kernel namespaces alive when the user currently has no processes
 * running running inside the sandbox.
 *
 * It also reaps all child processes that get reparented to it.
 */
#include <signal.h>
#include <unistd.h>

int main() {
    for (int fd = 0; fd < 3; fd++) {
        close(fd);
    }

    signal(SIGCHLD, SIG_IGN);

    while (1) {
        pause();
    }
}
