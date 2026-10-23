/**
 * Shield Software Global Toast Notification & Confirmation Manager
 */
(function (global) {
  let toastContainer = null;

  function initContainer() {
    if (!toastContainer && typeof document !== "undefined") {
      toastContainer = document.createElement("div");
      toastContainer.id = "arcanium-toast-container";
      toastContainer.style.cssText = `
        position: fixed;
        top: 24px;
        right: 24px;
        z-index: 999999;
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-width: 380px;
        width: calc(100% - 48px);
        pointer-events: none;
      `;
      document.body.appendChild(toastContainer);
    }
  }

  function createToastElement(message, type = "info") {
    initContainer();

    const toast = document.createElement("div");
    toast.className = `arcanium-toast toast-${type}`;
    toast.style.pointerEvents = "auto";

    let iconHtml = '<i class="fa-solid fa-circle-info"></i>';
    let bgColor = "rgba(15, 23, 42, 0.92)";
    let borderColor = "rgba(255, 255, 255, 0.1)";
    let textColor = "#f8fafc";
    let accentColor = "#38bdf8";

    if (type === "pending") {
      iconHtml = '<i class="fa-solid fa-hourglass-half fa-spin"></i>';
      bgColor = "rgba(28, 25, 23, 0.94)";
      borderColor = "rgba(245, 158, 11, 0.4)";
      accentColor = "#f59e0b";
      textColor = "#fef3c7";
    } else if (type === "success") {
      iconHtml = '<i class="fa-solid fa-circle-check"></i>';
      bgColor = "rgba(6, 30, 20, 0.94)";
      borderColor = "rgba(16, 185, 129, 0.4)";
      accentColor = "#10b981";
      textColor = "#d1fae5";
    } else if (type === "error") {
      iconHtml = '<i class="fa-solid fa-circle-xmark"></i>';
      bgColor = "rgba(35, 12, 16, 0.94)";
      borderColor = "rgba(239, 68, 68, 0.4)";
      accentColor = "#ef4444";
      textColor = "#fee2e2";
    }

    toast.style.cssText = `
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 18px;
      background: ${bgColor};
      border: 1px solid ${borderColor};
      border-left: 4px solid ${accentColor};
      border-radius: 14px;
      color: ${textColor};
      font-family: 'Inter', system-ui, sans-serif;
      font-size: 13.5px;
      font-weight: 500;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.05);
      transform: translateX(120%);
      opacity: 0;
      transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    `;

    toast.innerHTML = `
      <div style="font-size: 18px; color: ${accentColor}; flex-shrink: 0;">${iconHtml}</div>
      <div style="flex: 1; line-height: 1.4; word-break: break-word;">${message}</div>
    `;

    toastContainer.appendChild(toast);

    // Trigger enter animation
    requestAnimationFrame(() => {
      toast.style.transform = "translateX(0)";
      toast.style.opacity = "1";
    });

    return toast;
  }

  function removeToast(toastElement) {
    if (!toastElement) return;
    toastElement.style.transform = "translateX(120%)";
    toastElement.style.opacity = "0";
    setTimeout(() => {
      if (toastElement.parentNode) {
        toastElement.parentNode.removeChild(toastElement);
      }
    }, 400);
  }

  const Toast = {
    show: function (message, type = "info", duration = 3500) {
      const toast = createToastElement(message, type);
      if (duration > 0) {
        setTimeout(() => removeToast(toast), duration);
      }
      return toast;
    },

    pending: function (message = "⏳ Onay bekliyor...") {
      return createToastElement(message, "pending");
    },

    success: function (message = "✅ Onay verildi — İşlem başarıyla gerçekleştirildi!") {
      return this.show(message, "success", 4000);
    },

    error: function (message = "❌ İşlem reddedildi veya hata oluştu.") {
      return this.show(message, "error", 4500);
    },

    dismiss: function (toastElement) {
      removeToast(toastElement);
    },

    /**
     * Executes an async operation with automated confirmation Toast flow:
     * 1. Shows "Onay bekliyor..." (pending yellow toast)
     * 2. Runs the operation
     * 3. Replaces with "Onay verildi" (success green toast) or error toast
     */
    execute: async function (asyncFn, pendingMsg = "⏳ Onay bekliyor...", successMsg = "✅ Onay verildi — İşlem gerçekleştirildi!", errorMsg = "❌ İşlem gerçekleştirilemedi.") {
      const pendingToast = this.pending(pendingMsg);
      try {
        const result = await asyncFn();
        this.dismiss(pendingToast);
        
        if (result && result.success === false) {
          this.error(result.message || errorMsg);
        } else {
          this.success((result && result.message) ? `✅ Onay verildi — ${result.message}` : successMsg);
        }
        return result;
      } catch (err) {
        this.dismiss(pendingToast);
        this.error(err.message || errorMsg);
        throw err;
      }
    }
  };

  global.Toast = Toast;
  global.showToast = Toast.show.bind(Toast);

  // Global Form Interceptor for AJAX forms
  document.addEventListener("DOMContentLoaded", () => {
    document.body.addEventListener("submit", async (e) => {
      const form = e.target;
      if (form.getAttribute("data-toast") === "auto") {
        e.preventDefault();
        const pendingMsg = form.getAttribute("data-toast-pending") || "⏳ Onay bekliyor...";
        const successMsg = form.getAttribute("data-toast-success") || "✅ Onay verildi — İşlem gerçekleştirildi!";
        
        Toast.execute(async () => {
          const formData = new FormData(form);
          const response = await fetch(form.action, {
            method: form.method || "POST",
            body: formData,
            headers: {
              "Accept": "application/json"
            }
          });
          const data = await response.json();
          if (data.redirect) {
            setTimeout(() => { window.location.href = data.redirect; }, 1000);
          }
          return data;
        }, pendingMsg, successMsg);
      }
    });
  });

})(typeof window !== "undefined" ? window : global);
