import './globals.css';

export const metadata = {
  title: 'Email Verify Studio',
  description: 'Validate single or bulk emails with syntax, MX, and SMTP checks.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
