// 서버 안내 메시지 번역. 한국어 문장(템플릿)이 키이고, 화면이 보낸 x-lang 헤더(ko/en/ja/zh)로 고른다.
// {name} 자리는 params로 채운다. 표에 없는 문장은 한국어 그대로 보낸다.
const LANGS = ['ko', 'en', 'ja', 'zh'];

const MESSAGES = {
  '투표가 완료되었습니다! 담당자에게 직접 문의해주세요.': {
    en: 'Voting is closed! Please contact the organizer directly.',
    ja: '投票は締め切られました！担当者に直接お問い合わせください。',
    zh: '投票已结束！请直接联系负责人。',
  },
  '관리자 키가 올바르지 않습니다.': {
    en: 'The admin key is incorrect.',
    ja: '管理者キーが正しくありません。',
    zh: '管理员密钥不正确。',
  },
  '기본 위치 "{place}"를 찾지 못했습니다.': {
    en: 'Could not find the default location "{place}".',
    ja: '既定の場所「{place}」が見つかりませんでした。',
    zh: '找不到默认位置“{place}”。',
  },
  '이미 새로운 투표가 시작되었습니다. 화면을 새로고침해 주세요.': {
    en: 'A new vote has already started. Please refresh the page.',
    ja: '新しい投票がすでに始まっています。画面を更新してください。',
    zh: '新的投票已经开始，请刷新页面。',
  },
  '지원하지 않는 반경입니다.': { en: 'Unsupported radius.', ja: '対応していない半径です。', zh: '不支持的半径。' },
  '좌표가 올바르지 않습니다.': { en: 'Invalid coordinates.', ja: '座標が正しくありません。', zh: '坐标无效。' },
  '장소 정보가 올바르지 않습니다.': { en: 'Invalid place information.', ja: '場所の情報が正しくありません。', zh: '地点信息无效。' },
  '알 수 없는 위치 지정 방식입니다.': { en: 'Unknown location mode.', ja: '不明な位置指定方法です。', zh: '未知的位置设置方式。' },
  '검색어를 입력해 주세요.': { en: 'Please enter a search term.', ja: '検索語を入力してください。', zh: '请输入搜索词。' },
  '저장할 수 있는 가게가 없습니다. {errors}': {
    en: 'There are no restaurants that can be saved. {errors}',
    ja: '保存できるお店がありません。{errors}',
    zh: '没有可以保存的餐厅。{errors}',
  },
  '저장할 가게가 없습니다.': { en: 'There are no restaurants to save.', ja: '保存するお店がありません。', zh: '没有要保存的餐厅。' },
  '저장된 목록에 없는 가게입니다.': {
    en: 'This restaurant is not in the saved list.',
    ja: '保存済みリストにないお店です。',
    zh: '该餐厅不在已保存的列表中。',
  },
  '이미 투표가 진행 중입니다. 다시 뽑으려면 관리자 키가 필요합니다.': {
    en: 'A vote is already in progress. The admin key is required to draw again.',
    ja: 'すでに投票中です。引き直すには管理者キーが必要です。',
    zh: '投票正在进行中。重新抽选需要管理员密钥。',
  },
  '가게 목록(restaurants.json)이 비어 있고 KAKAO_REST_API_KEY도 없어 후보를 뽑을 수 없습니다. README를 참고해 가게를 등록해 주세요.': {
    en: 'No candidates can be drawn: the restaurant list is empty and KAKAO_REST_API_KEY is not set. Please register restaurants (see README).',
    ja: 'お店リストが空で KAKAO_REST_API_KEY もないため候補を選べません。README を参考にお店を登録してください。',
    zh: '餐厅列表为空且未设置 KAKAO_REST_API_KEY，无法抽选候选。请参考 README 登记餐厅。',
  },
  '등록된 가게 중 반경 {radius}m 안에 있는 곳이 없습니다. 반경을 넓히거나 위치를 바꿔 보세요.': {
    en: 'No registered restaurant is within {radius}m. Try a larger radius or another location.',
    ja: '登録されたお店のうち半径{radius}m以内のお店がありません。半径を広げるか場所を変えてみてください。',
    zh: '已登记的餐厅中没有位于{radius}米范围内的。请扩大半径或更换位置。',
  },
  '반경 {radius}m 안에서 맛집을 찾지 못했습니다. 반경을 넓히거나 위치를 바꿔 보세요.': {
    en: 'No restaurants found within {radius}m. Try a larger radius or another location.',
    ja: '半径{radius}m以内でお店が見つかりませんでした。半径を広げるか場所を変えてみてください。',
    zh: '在{radius}米范围内没有找到餐厅。请扩大半径或更换位置。',
  },
  '투표자 정보가 올바르지 않습니다.': { en: 'Invalid voter information.', ja: '投票者の情報が正しくありません。', zh: '投票者信息无效。' },
  '후보에 없는 가게입니다.': { en: 'This restaurant is not a candidate.', ja: '候補にないお店です。', zh: '该餐厅不在候选中。' },
  '메뉴는 {n}개까지 고를 수 있습니다.': {
    en: 'You can pick up to {n} menu items.',
    ja: 'メニューは{n}個まで選べます。',
    zh: '最多可以选择{n}个菜品。',
  },
  '이 가게 메뉴에 없는 항목입니다.': {
    en: "This item is not on this restaurant's menu.",
    ja: 'このお店のメニューにない項目です。',
    zh: '该菜品不在这家餐厅的菜单中。',
  },
  '메뉴 목록이 올바르지 않습니다.': { en: 'Invalid menu list.', ja: 'メニューリストが正しくありません。', zh: '菜单列表无效。' },
  '메뉴 이름을 입력해 주세요.': { en: 'Please enter a menu name.', ja: 'メニュー名を入力してください。', zh: '请输入菜品名称。' },
  '이 가게에는 메뉴를 더 추가할 수 없습니다.': {
    en: 'No more menu items can be added to this restaurant.',
    ja: 'このお店にはこれ以上メニューを追加できません。',
    zh: '这家餐厅无法再添加菜品。',
  },
  '동점인 가게가 없어 랜덤 뽑기가 필요하지 않습니다.': {
    en: 'There is no tie, so a random draw is not needed.',
    ja: '同点のお店がないため、ランダム抽選は不要です。',
    zh: '没有平票，无需随机抽选。',
  },
  '아직 투표가 없습니다.': { en: 'No votes yet.', ja: 'まだ投票がありません。', zh: '还没有投票。' },
  '동점입니다. 먼저 랜덤 뽑기를 진행해 주세요.': {
    en: "It's a tie. Please run the random draw first.",
    ja: '同点です。先にランダム抽選を行ってください。',
    zh: '出现平票，请先进行随机抽选。',
  },
  '서버에 KAKAO_REST_API_KEY가 설정되지 않아 맛집을 검색할 수 없습니다.': {
    en: 'Restaurant search is unavailable because KAKAO_REST_API_KEY is not set on the server.',
    ja: 'サーバーに KAKAO_REST_API_KEY が設定されていないため、お店を検索できません。',
    zh: '服务器未设置 KAKAO_REST_API_KEY，无法搜索餐厅。',
  },
  '카카오 API에 연결하지 못했습니다: {error}': {
    en: 'Could not connect to the Kakao API: {error}',
    ja: 'Kakao API に接続できませんでした: {error}',
    zh: '无法连接 Kakao API：{error}',
  },
  '카카오 API 오류 (HTTP {status})': { en: 'Kakao API error (HTTP {status})', ja: 'Kakao API エラー (HTTP {status})', zh: 'Kakao API 错误 (HTTP {status})' },
  'SB는 관리자 전용 이름입니다. 관리자 키를 입력해 주세요.': {
    en: 'SB is reserved for the admin. Please enter the admin key.',
    ja: 'SB は管理者専用の名前です。管理者キーを入力してください。',
    zh: 'SB 是管理员专用名称，请输入管理员密钥。',
  },
  '아직 가게가 결정되지 않았습니다.': {
    en: 'No restaurant has been decided yet.',
    ja: 'まだお店が決まっていません。',
    zh: '还没有决定餐厅。',
  },
  '가게를 한 곳 이상 골라 주세요.': { en: 'Please pick at least one restaurant.', ja: 'お店を1件以上選んでください。', zh: '请至少选择一家餐厅。' },
  '가게는 {n}곳까지 고를 수 있습니다.': { en: 'You can pick up to {n} restaurants.', ja: 'お店は{n}件まで選べます。', zh: '最多可以选择{n}家餐厅。' },
  '직접 입력한 가게 정보가 올바르지 않습니다.': {
    en: 'The restaurant you entered is invalid. A name and category are required.',
    ja: '入力したお店の情報が正しくありません。名前とカテゴリが必要です。',
    zh: '输入的餐厅信息无效，需要名称和类别。',
  },
  '그룹을 찾을 수 없습니다.': { en: 'Group not found.', ja: 'グループが見つかりません。', zh: '找不到该群组。' },
  '그룹 이름을 입력해 주세요.': { en: 'Please enter a group name.', ja: 'グループ名を入力してください。', zh: '请输入群组名称。' },
  '그룹을 더 만들 수 없습니다.': { en: 'No more groups can be created.', ja: 'これ以上グループを作成できません。', zh: '无法再创建更多群组。' },
  '이름을 입력해 주세요.': { en: 'Please enter your name.', ja: '名前を入力してください。', zh: '请输入名字。' },
  '이름을 먼저 등록해 주세요.': { en: 'Please register your name first.', ja: '先に名前を登録してください。', zh: '请先登记名字。' },
  '이름과 비밀번호를 입력해 주세요.': { en: 'Please enter your name and password.', ja: '名前とパスワードを入力してください。', zh: '请输入名字和密码。' },
  '비밀번호는 4자 이상 64자 이하로 입력해 주세요.': {
    en: 'The password must be 4 to 64 characters.',
    ja: 'パスワードは4〜64文字で入力してください。',
    zh: '密码长度需为 4 到 64 个字符。',
  },
  '비밀번호가 올바르지 않습니다.': { en: 'Incorrect password.', ja: 'パスワードが正しくありません。', zh: '密码不正确。' },
  '로그인해 주세요.': { en: 'Please sign in.', ja: 'ログインしてください。', zh: '请先登录。' },
  '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.': {
    en: 'Too many sign-in attempts. Please try again later.',
    ja: 'ログインの試行が多すぎます。しばらくしてから再度お試しください。',
    zh: '登录尝试次数过多，请稍后再试。',
  },
  '관리자 권한이 필요합니다.': { en: 'Admin permission is required.', ja: '管理者権限が必要です。', zh: '需要管理员权限。' },
  '전체 관리자(SB)만 볼 수 있습니다.': { en: 'Only the super admin (SB) can view this.', ja: '全体管理者（SB）のみ閲覧できます。', zh: '仅超级管理员（SB）可以查看。' },
  '확인할 수 없는 링크입니다.': { en: 'This link cannot be checked.', ja: '確認できないリンクです。', zh: '无法检查该链接。' },
  'SB 계정을 처음 만들 때는 관리자 키가 필요합니다.': {
    en: 'The admin key is required the first time the SB account is created.',
    ja: 'SB アカウントを初めて作成するときは管理者キーが必要です。',
    zh: '首次创建 SB 账号时需要管理员密钥。',
  },
  '존재하지 않는 API입니다.': { en: 'Unknown API.', ja: '存在しない API です。', zh: '不存在的 API。' },
  '요청 형식이 올바르지 않습니다.': { en: 'Invalid request format.', ja: 'リクエストの形式が正しくありません。', zh: '请求格式无效。' },
  '서버 오류가 발생했습니다.': { en: 'A server error occurred.', ja: 'サーバーエラーが発生しました。', zh: '服务器发生错误。' },
};

function pickLang(value) {
  const v = String(value || '').toLowerCase().slice(0, 2);
  return LANGS.includes(v) ? v : 'ko';
}

function translate(template, lang, params = {}) {
  const entry = MESSAGES[template];
  const text = (lang !== 'ko' && entry && entry[lang]) || template;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

module.exports = { translate, pickLang, MESSAGES, LANGS };
