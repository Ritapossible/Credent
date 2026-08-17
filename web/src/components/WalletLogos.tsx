/**
 * Wallet marks for the install list.
 *
 * A wallet that is already installed sends its own icon through EIP-6963 and the
 * picker shows that. These are for the other case - the visitor with no wallet at
 * all, who was previously offered three grey circles containing the letters M, R
 * and O. A list of unfamiliar names asking someone to install a key manager is
 * exactly where the recognisable mark does the work.
 *
 * The MetaMask and Rabby paths are the projects' own, inlined from their
 * repositories; the OKX mark is its five-square figure drawn from geometry.
 * Inline rather than fetched or bundled as files because the site's CSP allows no
 * remote image host, and using a mark to name the thing it belongs to is what it
 * is for - nothing here implies an endorsement in either direction.
 *
 * Each is a plain 32-unit square so it drops into the same slot as a wallet's own
 * icon without a wrapper.
 */

/** From `metamask-extension/app/images/logo/metamask-fox.svg`. */
export function MetaMaskLogo() {
  return (
    <svg
      className="wallet-option__icon"
      viewBox="0 0 35 33"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g strokeLinecap="round" strokeLinejoin="round" strokeWidth=".25">
        <path d="m32.9582 1-13.1341 9.7183 2.4424-5.72731z" fill="#e17726" stroke="#e17726" />
        <g fill="#e27625" stroke="#e27625">
          <path d="m2.66296 1 13.01714 9.809-2.3254-5.81802z" />
          <path d="m28.2295 23.5335-3.4947 5.3386 7.4829 2.0603 2.1436-7.2823z" />
          <path d="m1.27281 23.6501 2.13055 7.2823 7.46994-2.0603-3.48166-5.3386z" />
          <path d="m10.4706 14.5149-2.0786 3.1358 7.405.3369-.2469-7.969z" />
          <path d="m25.1505 14.5149-5.1575-4.58704-.1688 8.05974 7.4049-.3369z" />
          <path d="m10.8733 28.8721 4.4819-2.1639-3.8583-3.0062z" />
          <path d="m20.2659 26.7082 4.4689 2.1639-.6105-5.1701z" />
        </g>
        <path
          d="m24.7348 28.8721-4.469-2.1639.3638 2.9025-.039 1.231z"
          fill="#d5bfb2"
          stroke="#d5bfb2"
        />
        <path
          d="m10.8732 28.8721 4.1572 1.9696-.026-1.231.3508-2.9025z"
          fill="#d5bfb2"
          stroke="#d5bfb2"
        />
        <path d="m15.1084 21.7842-3.7155-1.0884 2.6243-1.2051z" fill="#233447" stroke="#233447" />
        <path d="m20.5126 21.7842 1.0913-2.2935 2.6372 1.2051z" fill="#233447" stroke="#233447" />
        <path d="m10.8733 28.8721.6495-5.3386-4.13117.1167z" fill="#cc6228" stroke="#cc6228" />
        <path d="m24.0982 23.5335.6366 5.3386 3.4946-5.2219z" fill="#cc6228" stroke="#cc6228" />
        <path
          d="m27.2291 17.6507-7.405.3369.6885 3.7966 1.0913-2.2935 2.6372 1.2051z"
          fill="#cc6228"
          stroke="#cc6228"
        />
        <path
          d="m11.3929 20.6958 2.6242-1.2051 1.0913 2.2935.6885-3.7966-7.40495-.3369z"
          fill="#cc6228"
          stroke="#cc6228"
        />
        <path d="m8.392 17.6507 3.1049 6.0513-.1039-3.0062z" fill="#e27525" stroke="#e27525" />
        <path d="m24.2412 20.6958-.1169 3.0062 3.1049-6.0513z" fill="#e27525" stroke="#e27525" />
        <path
          d="m15.797 17.9876-.6886 3.7967.8704 4.4833.1949-5.9087z"
          fill="#e27525"
          stroke="#e27525"
        />
        <path
          d="m19.8242 17.9876-.3638 2.3584.1819 5.9216.8704-4.4833z"
          fill="#e27525"
          stroke="#e27525"
        />
        <path
          d="m20.5127 21.7842-.8704 4.4834.6236.4406 3.8584-3.0062.1169-3.0062z"
          fill="#f5841f"
          stroke="#f5841f"
        />
        <path
          d="m11.3929 20.6958.104 3.0062 3.8583 3.0062.6236-.4406-.8704-4.4834z"
          fill="#f5841f"
          stroke="#f5841f"
        />
        <path
          d="m20.5906 30.8417.039-1.231-.3378-.2851h-4.9626l-.3248.2851.026 1.231-4.1572-1.9696 1.4551 1.1921 2.9489 2.0344h5.0536l2.962-2.0344 1.442-1.1921z"
          fill="#c0ac9d"
          stroke="#c0ac9d"
        />
        <path
          d="m20.2659 26.7082-.6236-.4406h-3.6635l-.6236.4406-.3508 2.9025.3248-.2851h4.9626l.3378.2851z"
          fill="#161616"
          stroke="#161616"
        />
        <path
          d="m33.5168 11.3532 1.1043-5.36447-1.6629-4.98873-12.6923 9.3944 4.8846 4.1205 6.8983 2.0085 1.52-1.7752-.6626-.4795 1.0523-.9588-.8054-.622 1.0523-.8034z"
          fill="#763e1a"
          stroke="#763e1a"
        />
        <path
          d="m1 5.98873 1.11724 5.36447-.71451.5313 1.06527.8034-.80545.622 1.05228.9588-.66255.4795 1.51997 1.7752 6.89835-2.0085 4.8846-4.1205-12.69233-9.3944z"
          fill="#763e1a"
          stroke="#763e1a"
        />
        <path
          d="m32.0489 16.5234-6.8983-2.0085 2.0786 3.1358-3.1049 6.0513 4.1052-.0519h6.1318z"
          fill="#f5841f"
          stroke="#f5841f"
        />
        <path
          d="m10.4705 14.5149-6.89828 2.0085-2.29944 7.1267h6.11883l4.10519.0519-3.10487-6.0513z"
          fill="#f5841f"
          stroke="#f5841f"
        />
        <path
          d="m19.8241 17.9876.4417-7.5932 2.0007-5.4034h-8.9119l2.0006 5.4034.4417 7.5932.1689 2.3842.013 5.8958h3.6635l.013-5.8958z"
          fill="#f5841f"
          stroke="#f5841f"
        />
      </g>
    </svg>
  )
}

/**
 * From `Rabby/src/ui/assets/dashboard/rabby.svg`. The gradient ids carry a
 * `rabby-` prefix: ids are document-global, and the originals are hashes from the
 * design tool that would collide with anything else exported from the same file.
 */
export function RabbyLogo() {
  return (
    <svg
      className="wallet-option__icon"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M19.3838 11.1837C20.1286 9.52002 16.4468 4.87188 12.9295 2.93537C10.7124 1.43518 8.40221 1.64128 7.93432 2.29998C6.9075 3.74555 11.3344 4.97045 14.2951 6.39983C13.6586 6.67624 13.0589 7.17228 12.7062 7.80665C11.6025 6.60164 9.17989 5.56396 6.33724 6.39983C4.42164 6.96311 2.82963 8.29105 2.21432 10.2967C2.06481 10.2303 1.89928 10.1934 1.72513 10.1934C1.05916 10.1934 0.519287 10.7333 0.519287 11.3992C0.519287 12.0652 1.05916 12.6051 1.72513 12.6051C1.84857 12.6051 2.23453 12.5223 2.23453 12.5223L8.40221 12.567C5.93562 16.4799 3.98632 17.052 3.98632 17.7299C3.98632 18.4078 5.85145 18.2241 6.55177 17.9714C9.90427 16.7617 13.505 12.9918 14.1229 11.9065C16.7176 12.2302 18.8983 12.2685 19.3838 11.1837Z"
        fill="url(#rabby-a)"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14.2947 6.40006C14.2949 6.40013 14.295 6.40021 14.2952 6.40028C14.4324 6.34622 14.4102 6.14354 14.3725 5.98438C14.2859 5.61855 12.7916 4.14293 11.3883 3.48199C9.47625 2.58142 8.06824 2.6278 7.86011 3.04284C8.24958 3.84115 10.0553 4.59066 11.9412 5.37346C12.7458 5.70743 13.565 6.04745 14.2951 6.39991C14.2949 6.39996 14.2948 6.40001 14.2947 6.40006Z"
        fill="url(#rabby-b)"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.8686 14.4346C11.4819 14.2868 11.0451 14.1512 10.5484 14.0282C11.0779 13.0807 11.1891 11.678 10.689 10.7911C9.98712 9.54649 9.1061 8.88403 7.05884 8.88403C5.93283 8.88403 2.90114 9.26331 2.84732 11.7941C2.84167 12.0596 2.84718 12.303 2.8664 12.5268L8.4025 12.5669C7.65616 13.7509 6.95718 14.629 6.34523 15.2968C7.07996 15.485 7.68629 15.6431 8.24294 15.7882C8.77114 15.9259 9.25462 16.0519 9.76063 16.181C10.524 15.6249 11.2416 15.0185 11.8686 14.4346Z"
        fill="url(#rabby-c)"
      />
      <path
        d="M2.14044 12.2667C2.36659 14.1893 3.4592 14.9427 5.69184 15.1657C7.92448 15.3886 9.20516 15.2391 10.9102 15.3942C12.3342 15.5237 13.6057 16.2494 14.0773 15.9986C14.5019 15.7729 14.2644 14.9576 13.6963 14.4345C12.96 13.7564 11.941 13.2849 10.1479 13.1176C10.5052 12.1392 10.4051 10.7673 9.85009 10.021C9.04764 8.94179 7.56647 8.45388 5.69184 8.66705C3.73329 8.88977 1.85661 9.85402 2.14044 12.2667Z"
        fill="url(#rabby-d)"
      />
      <defs>
        <linearGradient
          id="rabby-a"
          x1="6.11419"
          y1="9.71043"
          x2="19.2235"
          y2="13.428"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#8797FF" />
          <stop offset="1" stopColor="#AAA8FF" />
        </linearGradient>
        <linearGradient
          id="rabby-b"
          x1="17.0159"
          y1="9.46126"
          x2="7.55701"
          y2="-0.0207884"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#3B22A0" />
          <stop offset="1" stopColor="#5156D8" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id="rabby-c"
          x1="12.1318"
          y1="14.7649"
          x2="3.0454"
          y2="9.54082"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#3B1E8F" />
          <stop offset="1" stopColor="#6A6FFB" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id="rabby-d"
          x1="6.89681"
          y1="9.61258"
          x2="13.0385"
          y2="17.4162"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#8898FF" />
          <stop offset="0.983895" stopColor="#5F47F1" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/**
 * The OKX mark: five squares on a 3x3 grid, drawn from geometry rather than
 * copied, because it is geometry - three rows of a nine-cell grid with the
 * corners and the centre filled. The plate is squared off at the same radius the
 * other two marks read at.
 */
export function OkxLogo() {
  const cells = [
    [0, 0],
    [2, 0],
    [1, 1],
    [0, 2],
    [2, 2],
  ]

  return (
    <svg
      className="wallet-option__icon"
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="8" fill="#000000" />
      {cells.map(([col, row]) => (
        <rect
          key={`${col}-${row}`}
          x={6 + col * 7}
          y={6 + row * 7}
          width="6"
          height="6"
          fill="#ffffff"
        />
      ))}
    </svg>
  )
}
