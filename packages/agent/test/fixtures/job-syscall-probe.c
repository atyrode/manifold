#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

/* Disposable test artifact, not an agent runtime dependency. Build statically for
 * the target architecture and supply MANIFOLD_TEST_SYSCALL_PROBE to the Linux and owner tests. */
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "worker") == 0) {
    fputs("private-once", stdout);
    fputs("diagnostic", stderr);
    return 0;
  }
  int sockets[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) != 0) return 10;
  int fd = open("/tmp/descriptor", O_CREAT | O_RDWR, 0600);
  if (fd < 0) return 11;
  char byte = 'x';
  struct iovec vector = {.iov_base = &byte, .iov_len = 1};
  union {
    struct cmsghdr alignment;
    char bytes[CMSG_SPACE(sizeof(int))];
  } control = {0};
  struct msghdr message = {
    .msg_iov = &vector,
    .msg_iovlen = 1,
    .msg_control = control.bytes,
    .msg_controllen = sizeof(control.bytes),
  };
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET;
  header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(header), &fd, sizeof(fd));
  errno = 0;
  if (syscall(SYS_sendmsg, sockets[0], &message, MSG_NOSIGNAL) != -1 || errno != EPERM)
    return 12;
  struct mmsghdr batch = {.msg_hdr = message};
  errno = 0;
  if (syscall(SYS_sendmmsg, sockets[0], &batch, 1, MSG_NOSIGNAL) != -1 || errno != EPERM)
    return 13;
  errno = 0;
  if (recvmsg(sockets[1], &message, MSG_DONTWAIT) != -1 || errno != EAGAIN) return 14;
  errno = 0;
  if (syscall(SYS_io_uring_setup, 1, NULL) != -1 || errno != EPERM) return 15;
  errno = 0;
  if (syscall(SYS_io_uring_enter, -1, 0, 0, 0, NULL, 0) != -1 || errno != EPERM) return 16;
  errno = 0;
  if (syscall(SYS_io_uring_register, -1, 0, NULL, 0) != -1 || errno != EPERM) return 17;
#if defined(__x86_64__)
  errno = 0;
  if (syscall(0x40000000L | SYS_sendmsg, sockets[0], &message, MSG_NOSIGNAL) != -1 ||
      errno != EPERM) return 18;
  pid_t child = fork();
  if (child < 0) return 19;
  if (child == 0) {
    long result;
    __asm__ volatile("int $0x80" : "=a"(result) : "0"(20) : "memory");
    _exit(20);
  }
  int status;
  if (waitpid(child, &status, 0) != child || !WIFSIGNALED(status) || WTERMSIG(status) != SIGSYS)
    return 21;
#endif
  if (write(sockets[0], "b", 1) != 1 || read(sockets[1], &byte, 1) != 1 || byte != 'b')
    return 22;
  if (write(3, "context-byte", 12) != 12 || read(3, &byte, 1) != 1 || byte != 'a') return 23;
  close(fd);
  close(sockets[0]);
  close(sockets[1]);
  puts("fd-export-denied;byte-context-ok");
  return 0;
}
