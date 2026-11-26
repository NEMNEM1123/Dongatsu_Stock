// 클라이언트 빌드 번호. 서버의 최소 버전보다 낮으면 새로고침을 안내한다.
// 호환이 깨지는 배포를 할 때 CLIENT_VERSION과 MIN_CLIENT_VERSION을 같이 올린다.
// (종목을 추가·삭제해 가격 배열의 순서가 바뀌거나, 메시지 형식이 바뀌는 경우가 해당한다)
export const CLIENT_VERSION = 2;

// 서버가 받아들이는 최소 클라이언트 번호. 관리자 화면의 값이 이보다 낮아도 이 값이 하한선이다.
// 배포 전에 열어 둔 이전 화면이 새 서버와 어긋난 채로 계속 쓰이지 않도록 코드에 둔다.
export const MIN_CLIENT_VERSION = 2;

// 화면에 보여 주는 앱 버전 (사용자용 표기). 위의 CLIENT_VERSION은 호환성 비교용 번호라서 따로 둔다.
export const APP_VERSION = "1.6.3";
