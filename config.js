// Supabase の接続先。ここに入れるのは「公開してよい鍵（publishable / anon）」だけ。
// service_role・secret の鍵は絶対に入れない（このファイルは誰でも見られる）。
window.HATSU_CONFIG = {
  url: "",          // 例: https://abcdefghijklmnop.supabase.co
  key: "",          // 例: sb_publishable_... か eyJ... の anon key
  emailDomain: "users.hatsudoya.app"  // ログイン用の内部アドレスの後ろ。メールは送らない。変えると今のアカウントに入れなくなる
};
