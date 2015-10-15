module.exports = {
  SOURCE: 'source.box',
  BOX: '%s.box',
  HOSTNAME: 'sourcebox',
  INIT_PATH: '/sbin',
  INIT_COMMAND: 'sourcebox-init',
  LOOPFILE: 'sourcebox.fs',
  MIN_LOOP_SIZE: '500MB',
  RESOLVMOUNT: '/etc/resolv.conf etc/resolv.conf none bind 0 0',
  USER: 'user',
  LANG: 'en_US.utf8',
  UID: 1000,
  SUBID_FIRST: 100000,
  SUBID_COUNT: 10000
};
