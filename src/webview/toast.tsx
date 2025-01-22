import React, { useEffect } from "react";

import styles from "./styles/toast.module.css";

interface ToastProps {
  message: string;
  duration?: number;
  onClose: () => void;
}

export const Toast: React.FC<ToastProps> = ({ message, duration = 2000, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onClose]);

  return (
    <div className={styles.toast}>
      <span className={styles.message}>{message}</span>
    </div>
  );
};

export const useToast = () => {
  const [toast, setToast] = React.useState<{ message: string; key: number } | null>(null);

  const showToast = React.useCallback((message: string) => {
    setToast({ message, key: Date.now() });
  }, []);

  const hideToast = React.useCallback(() => {
    setToast(null);
  }, []);

  return {
    Toast: toast ? (
      <Toast
        key={toast.key}
        message={toast.message}
        onClose={hideToast}
      />
    ) : null,
    showToast,
  };
};
