// 클라이언트 빌드 번호. 서버의 최소 버전보다 낮으면 새로고침을 안내한다.
// 호환이 깨지는 배포를 할 때 올리고, 관리자 화면에서 최소 버전을 같이 올린다.
export const CLIENT_VERSION = 1;

// 화면에 보여 주는 앱 버전 (사용자용 표기). 위의 CLIENT_VERSION은 호환성 비교용 번호라서 따로 둔다.
export const APP_VERSION = "1.1.2";
