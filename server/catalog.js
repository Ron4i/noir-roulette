/**
 * Каталог тем для « очередей по интересам и кодов жалоб.
 * Клиент берёт его с /api/catalog, поэтому список не дублируется во фронтенде.
 */
export const TOPICS = [
  { id: 'music', label: 'Музыка', emoji: '🎧' },
  { id: 'gaming', label: 'Игры', emoji: '🎮' },
  { id: 'anime', label: 'Аниме и манга', emoji: '🌸' },
  { id: 'movies', label: 'Кино и сериалы', emoji: '🎬' },
  { id: 'books', label: 'Книги', emoji: '📚' },
  { id: 'science', label: 'Наука и техника', emoji: '🔬' },
  { id: 'art', label: 'Творчество', emoji: '🎨' },
  { id: 'sport', label: 'Спорт', emoji: '⚽' },
  { id: 'food', label: 'Кулинария', emoji: '🍜' },
  { id: 'travel', label: 'Путешествия', emoji: '🧭' },
  { id: 'psychology', label: 'Психология', emoji: '🧠' },
  { id: 'career', label: 'Работа и карьера', emoji: '💼' },
  { id: 'biz', label: 'Бизнес и деньги', emoji: '📈' },
  { id: 'design', label: 'Дизайн', emoji: '✏️' },
  { id: 'photo', label: 'Фотография', emoji: '📷' },
  { id: 'pets', label: 'Животные', emoji: '🐾' },
  { id: 'health', label: 'Здоровье и спорт-зал', emoji: '🏋️' },
  { id: 'edu', label: 'Учёба и языки', emoji: '🗣️' },
  { id: 'humor', label: 'Юмор и мемы', emoji: '😂' },
  { id: 'auto', label: 'Авто и мото', emoji: '🏍️' },
  { id: 'home', label: 'Дом и ремонт', emoji: '🛋️' },
  { id: 'gadgets', label: 'Гаджеты', emoji: '💻' },
  { id: 'dance', label: 'Танцы', emoji: '🕺' },
  { id: 'family', label: 'Семья и дети', emoji: '👨‍👩‍👧' },
  { id: 'philosophy', label: 'Философия', emoji: '🌀' },
  { id: 'news', label: 'Новости и обсуждения', emoji: '📰' },
  { id: 'justchat', label: 'Просто поболтать', emoji: '☕' },
];

/** Коды жалоб: причина → как она влияет на дальнейшую судьбу сессии. */
export const REPORT_REASONS = {
  harassment: { label: 'Оскорбления, травля', weight: 3 },
  nudity: { label: 'Неприемлемый контент', weight: 4 },
  minors: { label: 'Несовершеннолетние', weight: 5 },
  scam: { label: 'Мошенничество, ссылки', weight: 3 },
  spam: { label: 'Спам, реклама', weight: 2 },
  impersonation: { label: 'Выдаёт себя за другого', weight: 3 },
  other: { label: 'Другое', weight: 2 },
};

/** @param {unknown} id */
export function isKnownTopic(id) {
  return typeof id === 'string' && TOPICS.some((t) => t.id === id);
}
