export type SettingsFeedback = {
  tone: "success" | "danger";
  message: string;
};

export type SettingsNoticeHandlers = {
  setError: (message: string | null) => void;
  setFeedback: (feedback: SettingsFeedback | null) => void;
};
